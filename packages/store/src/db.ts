/**
 * Connection setup for `@ship/store`.
 *
 * Centralizes the PRAGMA dance every connection has to do:
 *   `journal_mode = WAL` — readers don't block writers; reads of an in-flight
 *                          row from `mcp-server` while `core` is mid-write are
 *                          the common pattern.
 *   `foreign_keys  = ON` — SQLite ships with FKs OFF by default; the
 *                          `phases` / `cursor_runs` ON DELETE CASCADE rules
 *                          require this PRAGMA to mean anything.
 *   `busy_timeout  = 5000` — best-effort cross-process serialization. `cli`
 *                            and `mcp-server` may both invoke `core` against
 *                            the same `state.db` file at the same time.
 *                            5s of internal blocking hides sub-second write
 *                            contention without a retry loop in `core`.
 *
 * `PRAGMA journal_mode` is read back after we set it: SQLite silently falls
 * back to the rollback journal on filesystems that don't support WAL (notably
 * networked filesystems). We log a warning rather than aborting — the store
 * still works on `delete`, just slower under read-while-write. Per
 * phases/03-store.md § F2 / Risks.
 */

import type { Database as BetterSqlite3Database } from "better-sqlite3";

import Database from "better-sqlite3";

/**
 * Opaque alias for `better-sqlite3`'s `Database` handle.
 *
 * Re-exported as a type-only alias so the rest of the package can refer to a
 * connection without importing `better-sqlite3` everywhere. Not part of the
 * public package surface — `index.ts` does NOT re-export this.
 */
export type Db = BetterSqlite3Database;

/** Internal: the busy_timeout we apply to every connection, in ms. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens `dbPath` and applies the PRAGMA setup every Ship connection requires.
 *
 * Behavior:
 * 1. Constructs a `better-sqlite3` `Database` handle. `":memory:"` is
 *    accepted verbatim and produces an in-memory DB (used by tests).
 * 2. Sets `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
 * 3. Reads `PRAGMA journal_mode` back. If the result is not `"wal"`, logs a
 *    warning to `console.warn` but returns the handle — the store remains
 *    usable on a rollback journal.
 *
 * If the PRAGMA setup itself throws (e.g. read-only path, unwritable DB),
 * the just-opened handle is closed before re-throwing — otherwise a long-
 * lived caller (daemon path, retry loops) accumulates open file handles
 * and SQLite locks.
 *
 * Returns the connection handle. The caller (`createStore`) is responsible
 * for running migrations and closing on shutdown.
 *
 * Synchronous, matching `better-sqlite3`'s API.
 */
export function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath);
  try {
    configureConnection(db);
  } catch (err: unknown) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Applies the standard PRAGMA setup to an already-open connection.
 *
 * Split out from `openDatabase` so tests can inspect the configured handle
 * without re-opening, and so future "open without configuring" callers (none
 * in V1) have an explicit seam to skip. Reads `journal_mode` back and warns
 * via `console.warn` on a silent fallback (e.g. networked FS).
 *
 * `memory` is treated as acceptable: it's what SQLite reports for
 * `:memory:` databases (which never persist anything), so warning would
 * be noise on the test path.
 */
function configureConnection(db: Db): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);

  const journalMode = db.pragma("journal_mode", { simple: true }) as string;
  if (journalMode !== "wal" && journalMode !== "memory") {
    console.warn(
      `[@ship/store] PRAGMA journal_mode = WAL was not honored; running in '${journalMode}' mode. ` +
        "This is usually a networked filesystem; reads will block writers but the store remains correct.",
    );
  }
}

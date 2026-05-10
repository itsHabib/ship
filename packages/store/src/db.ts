/**
 * Connection setup for `@ship/store`. Centralizes the PRAGMA setup every
 * connection requires (WAL, foreign_keys, busy_timeout). Per
 * phases/03-store.md § F2 / Risks.
 */

import type { Database as BetterSqlite3Database } from "better-sqlite3";

import Database from "better-sqlite3";

/**
 * Opaque alias for `better-sqlite3`'s `Database` handle. Internal — not
 * re-exported from `index.ts`.
 */
export type Db = BetterSqlite3Database;

const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens `dbPath` and applies the standard PRAGMA setup.
 *
 * `:memory:` is accepted verbatim. On PRAGMA failure (read-only path, etc.)
 * the handle is closed before re-throwing so callers don't leak file handles
 * or SQLite locks.
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
 * Applies the standard PRAGMA setup. Reads `journal_mode` back and warns on
 * silent fallback (e.g. networked FS). `memory` is acceptable for `:memory:`
 * DBs.
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

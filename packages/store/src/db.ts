/**
 * Connection setup for `@ship/store`. Centralizes the PRAGMA setup every
 * connection requires (WAL, foreign_keys, busy_timeout). Per
 * phases/03-store.md § F2 / Risks.
 */

import type { Database as BetterSqlite3Database } from "better-sqlite3";

import Database from "better-sqlite3";

import { StoreContentionError } from "./errors.js";

/**
 * Opaque alias for `better-sqlite3`'s `Database` handle. Internal — not
 * re-exported from `index.ts`.
 */
export type Db = BetterSqlite3Database;

/**
 * Milliseconds SQLite blocks on `SQLITE_BUSY` before surfacing an error.
 * Raised from 5s after 2026-06-01 triple local-run contention (three
 * overlapping 30m streams against one `state.db`).
 */
export const BUSY_TIMEOUT_MS = 30_000;

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
    configureConnection(db, dbPath);
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
function configureConnection(db: Db, dbPath: string): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);

  const journalMode = db.pragma("journal_mode", { simple: true }) as string;
  if (journalMode !== "wal" && journalMode !== "memory") {
    console.warn(
      `[@ship/store] PRAGMA journal_mode = WAL was not honored for '${dbPath}'; running in '${journalMode}' mode. ` +
        "This is usually a networked filesystem; cross-process writes are more likely to hit lock contention.",
    );
  }
}

/** True when `better-sqlite3` surfaced lock contention after `busy_timeout`. */
export function isSqliteBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (code === "SQLITE_BUSY") return true;
  return err.message.includes("database is locked");
}

/**
 * Runs `fn` and maps SQLite lock failures to {@link StoreContentionError} so
 * callers get an operator-facing contention message.
 */
export function withStoreContentionGuard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err: unknown) {
    if (isSqliteBusyError(err)) {
      throw new StoreContentionError(err);
    }
    throw err;
  }
}

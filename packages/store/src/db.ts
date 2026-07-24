/**
 * Connection setup for `@ship/store`. Centralizes the PRAGMA setup every
 * connection requires (WAL, foreign_keys, busy_timeout). Per
 * phases/03-store.md § F2 / Risks.
 */

import type { Logger } from "@ship/logger";
import type { Database as BetterSqlite3Database } from "better-sqlite3";

import Database from "better-sqlite3";

import { StoreContentionError, StoreIntegrityError } from "./errors.js";

/**
 * Opaque alias for `better-sqlite3`'s `Database` handle. Internal — not
 * re-exported from `index.ts`.
 */
export type Db = BetterSqlite3Database;

/**
 * Milliseconds SQLite blocks on `SQLITE_BUSY` before surfacing an error.
 * Raised from 5s to tolerate concurrent local streams against one `state.db`.
 */
export const BUSY_TIMEOUT_MS = 30_000;

/**
 * Opens `dbPath` and applies the standard PRAGMA setup.
 *
 * `:memory:` is accepted verbatim. On PRAGMA failure (read-only path, etc.)
 * the handle is closed before re-throwing so callers don't leak file handles
 * or SQLite locks.
 */
export function openDatabase(dbPath: string, logger?: Logger): Db {
  const db = new Database(dbPath);
  try {
    // busy_timeout FIRST so the integrity read below (and the WAL pragma) wait
    // out a concurrent writer's lock rather than surfacing a spurious busy.
    db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    // Integrity gate BEFORE any page-touching pragma (WAL / foreign_keys): a
    // corrupt b-tree must be refused up front, not discovered mid-configure.
    assertIntegrity(db, dbPath);
    configureConnection(db, dbPath, logger);
  } catch (err: unknown) {
    db.close();
    // A failed integrity check is terminal — surface it verbatim so the
    // operator sees the recovery path instead of a downstream SQLite error
    // once writes start landing on the corrupt b-tree.
    if (err instanceof StoreIntegrityError) throw err;
    // Corruption bad enough to fault a pragma read surfaces as a raw
    // SQLITE_CORRUPT ("database disk image is malformed"); map it to the same
    // operator-facing integrity error. `isSqliteCorruptError` implies
    // `err instanceof Error`, so `.message` is safe.
    if (isSqliteCorruptError(err)) throw new StoreIntegrityError(dbPath, (err as Error).message);
    // The PRAGMA setup (and migrations on open) can hit lock contention under
    // concurrent local runs; surface the operator-facing hint instead of a raw
    // SQLITE_BUSY on the startup path.
    if (isSqliteBusyError(err)) throw new StoreContentionError(err);
    throw err;
  }
  return db;
}

/**
 * Runs `PRAGMA quick_check` and throws {@link StoreIntegrityError} unless the
 * b-tree is clean. `quick_check` skips the (slow) index-vs-table cross-checks
 * of `integrity_check` but still catches the page-level b-tree corruption that
 * concurrent long-lived writers on `%APPDATA%` produced — the failure mode this
 * gate exists to refuse. A fresh/empty DB reports `ok`.
 *
 * This is a gate, not a repair: on failure the caller closes the handle and
 * refuses to open, so no write ever lands on a corrupt page. `quick_check` may
 * itself throw `SQLITE_CORRUPT` on severe damage; `openDatabase` maps that to
 * the same {@link StoreIntegrityError}.
 */
function assertIntegrity(db: Db, dbPath: string): void {
  const rows = db.pragma("quick_check") as { quick_check?: unknown }[];
  const messages = rows
    .map((row) => (typeof row.quick_check === "string" ? row.quick_check : String(row.quick_check)))
    .filter((message) => message.length > 0);
  if (messages.length === 1 && messages[0] === "ok") return;
  // Fail OPEN on an inconclusive result (no usable rows): quick_check always
  // returns at least an "ok" row in practice, so an empty read is a pragma
  // anomaly, not proof of corruption — never brick a healthy db on ambiguity.
  if (messages.length === 0) return;
  // Reaching here means quick_check reported at least one corruption message.
  throw new StoreIntegrityError(dbPath, messages.join("; "));
}

/**
 * Applies the standard PRAGMA setup. Reads `journal_mode` back and warns on
 * silent fallback (e.g. networked FS). `memory` is acceptable for `:memory:`
 * DBs.
 */
function configureConnection(db: Db, dbPath: string, logger?: Logger): void {
  // `busy_timeout` is installed by `openDatabase` before the integrity gate, so
  // this pragma (which can need a write lock at startup) already waits the full
  // timeout under concurrent local runs rather than better-sqlite3's short
  // constructor default.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const journalMode = db.pragma("journal_mode", { simple: true }) as string;
  if (journalMode !== "wal" && journalMode !== "memory" && logger !== undefined) {
    logger.warn(
      { dbPath, journalMode },
      "PRAGMA journal_mode = WAL was not honored; cross-process writes are more likely to hit lock contention",
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
 * True when `better-sqlite3` surfaced on-disk corruption — the `SQLITE_CORRUPT`
 * code, or its "database disk image is malformed" / "file is not a database"
 * messages. Used to map a raw pragma-time fault onto {@link StoreIntegrityError}.
 */
export function isSqliteCorruptError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("SQLITE_CORRUPT")) return true;
  const message = err.message.toLowerCase();
  return message.includes("malformed") || message.includes("is not a database");
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

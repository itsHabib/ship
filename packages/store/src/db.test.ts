/**
 * Tests for `db.ts` — PRAGMA setup, lock detection, and cross-connection
 * contention tolerance on a file-backed `state.db`.
 */

import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  BUSY_TIMEOUT_MS,
  isSqliteBusyError,
  openDatabase,
  withStoreContentionGuard,
} from "./db.js";
import { LOCAL_RUN_CONTENTION_HINT, StoreContentionError, StoreIntegrityError } from "./errors.js";
import { runMigrations } from "./migrations.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ship-db-"));
  dbPath = join(tmpDir, "state.db");
});

afterEach(() => {
  rmSync(tmpDir, { force: true, recursive: true });
});

describe("openDatabase PRAGMAs (file-backed)", () => {
  test("three connections each see WAL and busy_timeout", () => {
    const dbs = [openDatabase(dbPath), openDatabase(dbPath), openDatabase(dbPath)];
    try {
      for (const db of dbs) {
        expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
        expect(db.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
      }
    } finally {
      for (const d of dbs) d.close();
    }
  });
});

describe("integrity gate (quick_check on open)", () => {
  test("a clean db opens; a corrupt b-tree page is refused with StoreIntegrityError", () => {
    // Build a db with several pages of data, then checkpoint into the main
    // file so the corruption we inject can't hide in a -wal sidecar.
    const seed = new Database(dbPath);
    seed.pragma("journal_mode = WAL");
    seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)");
    const insert = seed.prepare("INSERT INTO t (blob) VALUES (?)");
    for (let i = 0; i < 500; i++) insert.run("x".repeat(200));
    seed.pragma("wal_checkpoint(TRUNCATE)");
    seed.close();

    // Clean file opens fine and passes the gate.
    const ok = openDatabase(dbPath);
    expect(ok.pragma("quick_check", { simple: true })).toBe("ok");
    ok.close();

    // Corrupt a table b-tree page (well past the 100-byte header / page 1
    // schema page) so the file still opens but quick_check reports damage.
    const bytes = readFileSync(dbPath);
    const pageSize = bytes.readUInt16BE(16) || 4096;
    const corruptStart = pageSize * 2;
    expect(bytes.length).toBeGreaterThan(corruptStart + pageSize);
    bytes.fill(0xee, corruptStart, corruptStart + pageSize);
    writeFileSync(dbPath, bytes);

    expect(() => openDatabase(dbPath)).toThrow(StoreIntegrityError);
    try {
      openDatabase(dbPath);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(StoreIntegrityError);
      expect((err as StoreIntegrityError).dbPath).toBe(dbPath);
      expect((err as Error).message).toContain("integrity check failed");
      expect((err as Error).message).toContain("Refusing to open");
    }
  });
});

describe("isSqliteBusyError", () => {
  test("detects SQLITE_BUSY code and database is locked message", () => {
    const busy = new Error("database is locked") as Error & { code: string };
    busy.code = "SQLITE_BUSY";
    expect(isSqliteBusyError(busy)).toBe(true);

    const locked = new Error("database is locked");
    expect(isSqliteBusyError(locked)).toBe(true);

    expect(isSqliteBusyError(new Error("other failure"))).toBe(false);
  });
});

describe("withStoreContentionGuard", () => {
  test("maps SQLITE_BUSY to StoreContentionError with operator hint", () => {
    const busy = new Error("database is locked") as Error & { code: string };
    busy.code = "SQLITE_BUSY";
    expect(() =>
      withStoreContentionGuard(() => {
        throw busy;
      }),
    ).toThrow(StoreContentionError);
    try {
      withStoreContentionGuard(() => {
        throw busy;
      });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(StoreContentionError);
      expect((err as Error).message).toContain(LOCAL_RUN_CONTENTION_HINT);
      expect((err as Error).message).toContain("database is locked");
    }
  });
});

describe("concurrent connections on one file", () => {
  test("runMigrations from two handles on a fresh DB both succeed (busy_timeout + race-safe migrations)", () => {
    const db1 = openDatabase(dbPath);
    const db2 = openDatabase(dbPath);
    try {
      expect(() => {
        runMigrations(db1);
      }).not.toThrow();
      expect(() => {
        runMigrations(db2);
      }).not.toThrow();
    } finally {
      db1.close();
      db2.close();
    }
  });
});

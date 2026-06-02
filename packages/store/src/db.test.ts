/**
 * Tests for `db.ts` — PRAGMA setup, lock detection, and cross-connection
 * contention tolerance on a file-backed `state.db`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  BUSY_TIMEOUT_MS,
  isSqliteBusyError,
  openDatabase,
  withStoreContentionGuard,
} from "./db.js";
import { LOCAL_RUN_CONTENTION_HINT, StoreContentionError } from "./errors.js";
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

/**
 * Tests for `migrations.ts`.
 *
 * Coverage shape (per phases/03-store.md § "Migrations"):
 * - Fresh `:memory:` DB: runner creates `_migrations`, applies the real
 *   `0001_init.sql`, the three application tables exist and are queryable.
 * - Re-run is a no-op: `_migrations` still has one row.
 * - Synthetic `0002` migration: runner applies it on top of an already-
 *   migrated DB. Uses a tmp directory so we exercise the same readdir +
 *   readFileSync code path production uses.
 * - Mid-statement failure: txn rolls back, the `_migrations` row is not
 *   inserted, and a subsequent retry succeeds. Asserts atomicity.
 * - `MigrationError` shape: filename + `cause` populated.
 * - Injectable clock: `_migrations.applied_at` reflects the injected value.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Db } from "./db.js";

import { MigrationError } from "./errors.js";
import { runMigrations } from "./migrations.js";

interface MigrationRow {
  name: string;
  applied_at: string;
}

interface TableRow {
  name: string;
}

describe("runMigrations", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
  });

  test("fresh DB: creates _migrations, applies 0001_init.sql, all three tables exist", () => {
    runMigrations(db);

    const tables = db
      .prepare<[], TableRow>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);

    expect(tables).toContain("_migrations");
    expect(tables).toContain("workflow_runs");
    expect(tables).toContain("phases");
    expect(tables).toContain("cursor_runs");

    const applied = db.prepare<[], MigrationRow>("SELECT name, applied_at FROM _migrations").all();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe("0001_init.sql");
    expect(applied[0]?.applied_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("re-run on already-migrated DB is a no-op (single _migrations row)", () => {
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);

    const applied = db.prepare<[], MigrationRow>("SELECT name FROM _migrations").all();
    expect(applied).toHaveLength(1);
  });

  test("synthetic 0002 migration applies on top of 0001 via temp directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ship-store-migrations-"));
    try {
      writeFileSync(
        join(tmp, "0001_init.sql"),
        "CREATE TABLE alpha (id TEXT PRIMARY KEY);",
        "utf8",
      );
      writeFileSync(
        join(tmp, "0002_add_beta.sql"),
        "CREATE TABLE beta (id TEXT PRIMARY KEY);",
        "utf8",
      );

      runMigrations(db, { migrationsDir: tmp });

      const tables = db
        .prepare<[], TableRow>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(tables).toContain("alpha");
      expect(tables).toContain("beta");

      const applied = db
        .prepare<[], MigrationRow>("SELECT name FROM _migrations ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(applied).toEqual(["0001_init.sql", "0002_add_beta.sql"]);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  test("mid-statement failure: txn rolls back, _migrations row absent, retry succeeds", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ship-store-migrations-"));
    try {
      // Two CREATEs on the same name; the second fails, txn must roll back.
      writeFileSync(
        join(tmp, "0001_broken.sql"),
        "CREATE TABLE good (id TEXT PRIMARY KEY); CREATE TABLE good (id TEXT PRIMARY KEY);",
        "utf8",
      );

      expect(() => {
        runMigrations(db, { migrationsDir: tmp });
      }).toThrow(MigrationError);

      const tables = db
        .prepare<[], TableRow>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      expect(tables).not.toContain("good");

      const applied = db.prepare<[], MigrationRow>("SELECT name FROM _migrations").all();
      expect(applied).toHaveLength(0);

      // Fix the SQL and re-run; should succeed.
      writeFileSync(
        join(tmp, "0001_broken.sql"),
        "CREATE TABLE good (id TEXT PRIMARY KEY);",
        "utf8",
      );
      runMigrations(db, { migrationsDir: tmp });

      const fixedTables = db
        .prepare<[], TableRow>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      expect(fixedTables).toContain("good");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  test("MigrationError carries the filename and the underlying SQLite error as cause", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ship-store-migrations-"));
    try {
      writeFileSync(join(tmp, "0001_broken.sql"), "NOT VALID SQL;", "utf8");

      let caught: unknown;
      try {
        runMigrations(db, { migrationsDir: tmp });
      } catch (err: unknown) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MigrationError);
      const migErr = caught as MigrationError;
      expect(migErr.migrationName).toBe("0001_broken.sql");
      expect(migErr.cause).toBeInstanceOf(Error);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  test("injectable clock determines applied_at", () => {
    const fakeNow = "2026-05-08T00:00:00.000Z";
    runMigrations(db, { clock: () => fakeNow });

    const row = db.prepare<[], MigrationRow>("SELECT applied_at FROM _migrations").get();
    expect(row?.applied_at).toBe(fakeNow);
  });
});

/** Tests for `migrations.ts`. Pins idempotency, atomic rollback, and `MigrationError` shape. */

import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Db } from "./db.js";

import { MigrationError } from "./errors.js";
import { runMigrations } from "./migrations.js";

const SHIPPED_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
    expect(tables).toContain("driver_runs");
    expect(tables).toContain("driver_batches");
    expect(tables).toContain("driver_streams");

    const applied = db.prepare<[], MigrationRow>("SELECT name, applied_at FROM _migrations").all();
    expect(applied).toHaveLength(8);
    expect(applied.map((r) => r.name)).toEqual([
      "0001_init.sql",
      "0002_cursor_runs_run_id.sql",
      "0003_cursor_runs_artifacts_json.sql",
      "0004_phases_failure_category.sql",
      "0005_driver_runs.sql",
      "0006_driver_tick_lease.sql",
      "0007_cursor_runs_provider.sql",
      "0008_driver_streams_tier.sql",
    ]);

    const phaseColumns = db
      .prepare("PRAGMA table_info(phases)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(phaseColumns).toContain("failure_category");

    const columns = db
      .prepare("PRAGMA table_info(cursor_runs)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(columns).toContain("run_id");
    expect(columns).toContain("artifacts_json");
    expect(columns).toContain("provider");
  });

  test("re-run on already-migrated DB is a no-op (two _migrations rows)", () => {
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);

    const applied = db.prepare<[], MigrationRow>("SELECT name FROM _migrations").all();
    expect(applied).toHaveLength(8);
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

  test("0007_cursor_runs_provider backfills cursor on pre-existing rows", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ship-store-migrations-"));
    try {
      for (const name of [
        "0001_init.sql",
        "0002_cursor_runs_run_id.sql",
        "0003_cursor_runs_artifacts_json.sql",
        "0004_phases_failure_category.sql",
        "0005_driver_runs.sql",
        "0006_driver_tick_lease.sql",
      ]) {
        writeFileSync(
          join(tmp, name),
          readFileSync(join(SHIPPED_MIGRATIONS_DIR, name), "utf8"),
          "utf8",
        );
      }
      runMigrations(db, { migrationsDir: tmp });

      db.exec(`
        INSERT INTO workflow_runs (
          id, repo, doc_path, status, base_ref, worktree_json, policy_json, created_at, updated_at
        ) VALUES (
          'wf_test', 'ship', 'docs/x.md', 'running', 'main',
          '{"repo":"ship","name":"x","branch":"x","path":"/x","baseRef":"main"}',
          '{"baseRef":"main","maxRunDurationMs":1,"agentTimeoutMs":1}',
          '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z'
        );
        INSERT INTO cursor_runs (
          id, workflow_run_id, agent_id, runtime, status, started_at, artifacts_dir
        ) VALUES (
          'cr_test', 'wf_test', 'agent_legacy', 'cloud', 'running',
          '2026-05-08T00:00:00.000Z', '/runs/wf_test'
        );
      `);

      writeFileSync(
        join(tmp, "0007_cursor_runs_provider.sql"),
        readFileSync(join(SHIPPED_MIGRATIONS_DIR, "0007_cursor_runs_provider.sql"), "utf8"),
        "utf8",
      );
      runMigrations(db, { migrationsDir: tmp });

      const row = db.prepare("SELECT provider FROM cursor_runs WHERE id = 'cr_test'").get() as {
        provider: string;
      };
      expect(row.provider).toBe("cursor");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });
});

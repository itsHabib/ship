/**
 * Tests for `store.ts`. Pins connection PRAGMAs and the `close()`
 * contract; CRUD round-trips live in the per-table test files.
 */

import type { WorkflowPolicy, WorktreeRef } from "@ship/workflow";

import { newCursorRunId, newPhaseId, newWorkflowRunId } from "@ship/workflow";
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Store } from "./store.js";

import { openDatabase } from "./db.js";
import { SchemaAheadError, SchemaSkewError } from "./errors.js";
import { runMigrations } from "./migrations.js";
import { createStore } from "./store.js";

const SHIPPED_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const validWorktree: WorktreeRef = {
  baseRef: "main",
  branch: "ship/feat-x",
  name: "feat-x",
  path: "/repo/.worktrees/feat-x",
  repo: "ship",
};

const validPolicy: WorkflowPolicy = {
  agentTimeoutMs: 30 * 60 * 1000,
  baseRef: "main",
  maxRunDurationMs: 30 * 60 * 1000,
};

describe("createStore: connection setup PRAGMAs (file-backed)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ship-store-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("journal_mode = wal on a real file", () => {
    const store = createStore({ dbPath });
    try {
      // Open a second connection to inspect PRAGMAs without exposing the store's db handle.
      const sidecar = new Database(dbPath, { readonly: true });
      try {
        const mode = sidecar.pragma("journal_mode", { simple: true });
        expect(mode).toBe("wal");
      } finally {
        sidecar.close();
      }
    } finally {
      store.close();
    }
  });

  test("foreign_keys = ON: appendPhase to non-existent run is rejected", () => {
    const store = createStore({ dbPath });
    try {
      // FK enforcement verified indirectly: the typed-error translation requires foreign_keys = ON.
      expect(() =>
        store.appendPhase({
          id: newPhaseId(),
          inputJson: "{}",
          kind: "implement",
          workflowRunId: newWorkflowRunId(),
        }),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  test("openDatabase sets busy_timeout = 5000 on the connection", () => {
    // busy_timeout is per-connection; read PRAGMA back on a handle from openDatabase directly.
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });
});

describe("createStore: in-memory + clock + close()", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ clock: () => "2026-05-08T00:00:00.000Z", dbPath: ":memory:" });
  });

  afterEach(() => {
    // Each test owns its own close() lifecycle.
  });

  test(":memory: dbPath produces a working store", () => {
    const id = newWorkflowRunId();
    const run = store.createWorkflowRun({
      baseRef: "main",
      docPath: "docs/x.md",
      id,
      policy: validPolicy,
      repo: "ship",
      worktree: validWorktree,
    });
    expect(store.getRun(id)).toEqual(run);
    store.close();
  });

  test("close() makes subsequent calls throw", () => {
    store.close();
    expect(() => store.listRuns({})).toThrow();
  });
});

function copyShippedMigrationsTo(dir: string, filenames: string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of filenames) {
    copyFileSync(join(SHIPPED_MIGRATIONS_DIR, name), join(dir, name));
  }
}

describe("createStore: schema version guard", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ship-store-schema-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("store_open_with_behind_db_throws_schema_skew_error", () => {
    const migrationsDir = join(tmpDir, "migrations-subset");
    copyShippedMigrationsTo(migrationsDir, ["0001_init.sql", "0002_cursor_runs_run_id.sql"]);

    expect(() => createStore({ dbPath, migrationsDir })).toThrow(SchemaSkewError);
    expect(() => createStore({ dbPath, migrationsDir })).toThrow(
      /Restart ship to apply pending migrations/,
    );
  });

  test("store_open_with_ahead_db_throws_schema_ahead_error", () => {
    // Migrate the DB with every shipped migration PLUS a phantom extra, then
    // open against the real (shorter) migrations dir → DB is ahead of the build.
    const aheadDir = join(tmpDir, "migrations-ahead");
    mkdirSync(aheadDir, { recursive: true });
    for (const name of readdirSync(SHIPPED_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
      copyFileSync(join(SHIPPED_MIGRATIONS_DIR, name), join(aheadDir, name));
    }
    writeFileSync(
      join(aheadDir, "9999_phantom_future.sql"),
      "CREATE TABLE phantom_future (id TEXT PRIMARY KEY);",
      "utf8",
    );

    const db = openDatabase(dbPath);
    try {
      runMigrations(db, { migrationsDir: aheadDir });
    } finally {
      db.close();
    }

    // Default createStore uses the real shipped migrations dir (no phantom).
    expect(() => createStore({ dbPath })).toThrow(SchemaAheadError);
    expect(() => createStore({ dbPath })).toThrow(/ahead of the running code/);
  });

  test("store_open_applies_pending_migration_then_reads_ok", () => {
    const subsetDir = join(tmpDir, "migrations-subset");
    copyShippedMigrationsTo(subsetDir, ["0001_init.sql", "0002_cursor_runs_run_id.sql"]);

    const db = openDatabase(dbPath);
    try {
      runMigrations(db, { migrationsDir: subsetDir });
    } finally {
      db.close();
    }

    const sidecar = new Database(dbPath, { readonly: true });
    try {
      const columns = sidecar
        .prepare("PRAGMA table_info(cursor_runs)")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(columns).not.toContain("artifacts_json");
    } finally {
      sidecar.close();
    }

    const store = createStore({ clock: () => "2026-05-08T00:00:00.000Z", dbPath });
    try {
      const sidecarAfter = new Database(dbPath, { readonly: true });
      try {
        const columns = sidecarAfter
          .prepare("PRAGMA table_info(cursor_runs)")
          .all()
          .map((r) => (r as { name: string }).name);
        expect(columns).toContain("artifacts_json");
      } finally {
        sidecarAfter.close();
      }

      const runId = newWorkflowRunId();
      store.createWorkflowRun({
        baseRef: "main",
        docPath: "docs/x.md",
        id: runId,
        policy: validPolicy,
        repo: "ship",
        worktree: validWorktree,
      });

      const cursorRunId = newCursorRunId();
      store.recordCursorRun({
        agentId: "bc-art",
        artifactsDir: "/runs/wf_x",
        id: cursorRunId,
        runtime: "cloud",
        workflowRunId: runId,
      });

      const artifacts = [
        { path: "out/report.txt", sizeBytes: 14, updatedAt: "2026-05-29T00:00:00.000Z" },
      ];
      store.updateCursorRunStatus(cursorRunId, { artifacts });
      expect(store.getCursorRun(cursorRunId)?.artifacts).toEqual(artifacts);
    } finally {
      store.close();
    }
  });
});

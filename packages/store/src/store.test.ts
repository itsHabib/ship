/**
 * Tests for `store.ts`. Pins connection PRAGMAs and the `close()`
 * contract; CRUD round-trips live in the per-table test files.
 */

import type { WorkflowPolicy, WorktreeRef } from "@ship/workflow";

import { newPhaseId, newWorkflowRunId } from "@ship/workflow";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Store } from "./store.js";

import { openDatabase } from "./db.js";
import { createStore } from "./store.js";

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

/**
 * Scenario: concurrent readers tolerate writes via `busy_timeout`.
 *
 * Two `@ship/store` instances open the same file-backed DB. One performs
 * a write; the other performs a read concurrently (well, as concurrent
 * as JS lets us in a single-threaded test — the value here is exercising
 * the file-locking + WAL configuration, not actual parallelism).
 *
 * Asserts:
 * - both connections complete without `SQLITE_BUSY`
 * - the reader sees the writer's committed state
 * - the migration runner is race-safe (both `createStore` calls succeed
 *   even though both touched a fresh DB)
 *
 * This documents the cross-process tolerance from spec.md § "Non-functional
 * requirements" / phases/03-store.md § F2 — `cli` and `mcp-server` may
 * both invoke `core` against the same `state.db` file at the same time.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createHarness, createSampleWorkflowRunInput } from "../src/index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ship-scenario-concurrent-"));
});

afterEach(() => {
  rmSync(tmp, { force: true, recursive: true });
});

test("two harnesses sharing one dbPath: writer + reader both succeed; reader sees writer's commits", () => {
  const dbPath = join(tmp, "state.db");

  // First harness opens the file and performs a write.
  const writer = createHarness({ dbPath });
  try {
    const id = writer.ids.workflowRun();
    writer.store.createWorkflowRun(createSampleWorkflowRunInput(id));

    // Second harness opens the same file. Migration runner is race-safe
    // (BEGIN IMMEDIATE) — even though this is a "fresh DB" from the new
    // harness's perspective, its SELECT sees the migration the writer
    // ran on createStore, and pending is empty.
    const reader = createHarness({ dbPath });
    try {
      const fetched = reader.store.getRun(id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(id);

      // Reader does its own write while writer's connection is still open.
      // busy_timeout absorbs the lock contention; both succeed.
      const id2 = reader.ids.workflowRun();
      reader.store.createWorkflowRun(createSampleWorkflowRunInput(id2));

      // Writer sees reader's commit.
      expect(writer.store.getRun(id2)).not.toBeNull();
    } finally {
      reader.close();
    }
  } finally {
    writer.close();
  }
});

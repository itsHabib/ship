/** Scenario: two harnesses on one file-backed DB — exercises WAL + busy_timeout + race-safe migrations. */

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

    // Second harness opens the same file; migration runner is race-safe (BEGIN IMMEDIATE).
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

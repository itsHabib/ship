/**
 * Property-based checks for workflow-run persistence and listing.
 */

import type { WorkflowPolicy, WorkflowStatus, WorktreeRef } from "@ship/workflow";

import { fc, test } from "@fast-check/vitest";
import { newWorkflowRunId } from "@ship/workflow";
import { afterEach, beforeEach, describe, expect } from "vitest";

import type { Store } from "./store.js";
import type { CreateWorkflowRunInput } from "./workflow-runs.js";

import { createStore } from "./store.js";

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ITER = readPositiveIntEnv("SHIP_PROP_ITER", 100);
const PROP_SEED = readPositiveIntEnv("SHIP_PROP_SEED", 0x2fed12f);

fc.configureGlobal({ seed: PROP_SEED });

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

const repoArbitrary = fc.string({ minLength: 1, maxLength: 24 });
const docPathArbitrary = fc.string({ minLength: 1, maxLength: 64 });

const createInputArbitrary: fc.Arbitrary<CreateWorkflowRunInput> = fc
  .record({
    baseRef: fc.constant("main"),
    docPath: docPathArbitrary,
    policy: fc.constant(validPolicy),
    repo: repoArbitrary,
    worktree: fc.constant(validWorktree),
  })
  .map((r) => ({ ...r, id: newWorkflowRunId() }));

describe("workflow-runs properties (fast-check)", () => {
  let store: Store;
  let currentNow = "2026-05-08T00:00:00.000Z";

  beforeEach(() => {
    currentNow = "2026-05-08T00:00:00.000Z";
    store = createStore({ clock: () => currentNow, dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test.prop([createInputArbitrary], { numRuns: ITER })(
    "W1: createWorkflowRun → getRun round-trips the persisted row",
    (input) => {
      const created = store.createWorkflowRun(input);
      const fetched = store.getRun(input.id);
      expect(fetched).toEqual(created);
      expect(fetched?.repo).toBe(input.repo);
      expect(fetched?.docPath).toBe(input.docPath);
      expect(fetched?.status).toBe("pending");
    },
  );

  test.prop([fc.subarray(["pending", "running", "succeeded", "failed", "cancelled"] as const)], {
    numRuns: ITER,
  })("W2: listRuns status filter returns only rows whose status is in the filter", (filter) => {
    if (filter.length === 0) return;

    const ids = new Map<WorkflowStatus, string>();
    for (const status of [
      "pending",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ] as const satisfies readonly WorkflowStatus[]) {
      const input = {
        baseRef: "main",
        docPath: `docs/${status}.md`,
        id: newWorkflowRunId(),
        policy: validPolicy,
        repo: "ship",
        worktree: validWorktree,
      };
      store.createWorkflowRun(input);
      if (status !== "pending") {
        store.updateWorkflowRunStatus(input.id, status);
      }
      ids.set(status, input.id);
    }

    const listed = store.listRuns({ status: [...filter] });
    expect(listed.every((row) => filter.includes(row.status))).toBe(true);

    for (const status of filter) {
      const expectedId = ids.get(status);
      expect(listed.some((row) => row.id === expectedId)).toBe(true);
    }
  });
});

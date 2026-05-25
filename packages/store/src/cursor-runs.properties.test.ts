/**
 * Property-based checks for cursor-run persistence and resume listing.
 */

import type { ModelSelection, WorkflowPolicy, WorkflowStatus, WorktreeRef } from "@ship/workflow";

import { fc, test } from "@fast-check/vitest";
import { newCursorRunId, newWorkflowRunId } from "@ship/workflow";
import { afterEach, beforeEach, describe, expect } from "vitest";

import type { Store } from "./store.js";

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

const workflowStatusArbitrary: fc.Arbitrary<WorkflowStatus> = fc.constantFrom(
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
);

const cursorTerminalArbitrary = fc.constantFrom("succeeded", "failed", "cancelled" as const);

describe("cursor-runs properties (fast-check)", () => {
  let store: Store;
  let currentNow = "2026-05-08T00:00:00.000Z";

  beforeEach(() => {
    currentNow = "2026-05-08T00:00:00.000Z";
    store = createStore({ clock: () => currentNow, dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  function seedWorkflow(status: WorkflowStatus = "pending"): string {
    const id = newWorkflowRunId();
    store.createWorkflowRun({
      baseRef: "main",
      docPath: "docs/x.md",
      id,
      policy: validPolicy,
      repo: "ship",
      worktree: validWorktree,
    });
    if (status !== "pending") {
      store.updateWorkflowRunStatus(id, status);
    }
    return id;
  }

  test.prop(
    [
      fc.option(
        fc.record({
          id: fc.string({ minLength: 1 }),
          value: fc.oneof(fc.string({ minLength: 1 }), fc.boolean()),
        }),
        { nil: undefined },
      ),
    ],
    { numRuns: ITER },
  )("C1: recordCursorRun → getCursorRun round-trips optional model", (param) => {
    const wfId = seedWorkflow();
    const cursorRunId = newCursorRunId();
    const model: ModelSelection | undefined =
      param === undefined ? undefined : { id: "composer-2.5", params: [param] };

    const recorded = store.recordCursorRun({
      agentId: "agent_xyz",
      artifactsDir: "/runs/wf_x",
      id: cursorRunId,
      runtime: "local",
      workflowRunId: wfId,
      ...(model !== undefined ? { model } : {}),
    });

    expect(store.getCursorRun(cursorRunId)).toEqual(recorded);
  });

  test.prop([cursorTerminalArbitrary, fc.boolean()], { numRuns: ITER })(
    "C2: listResumableCloudCursorRuns excludes terminal cursor rows",
    (cursorTerminal, includeRunId) => {
      const wfId = seedWorkflow();
      const cursorRunId = newCursorRunId();
      store.recordCursorRun({
        agentId: "bc-resume",
        artifactsDir: "/runs/resume",
        id: cursorRunId,
        runtime: "cloud",
        workflowRunId: wfId,
        ...(includeRunId ? { runId: "run-resume-001" } : {}),
      });

      store.updateCursorRunStatus(cursorRunId, {
        endedAt: currentNow,
        status: cursorTerminal,
        durationMs: 1,
      });

      const resumable = store.listResumableCloudCursorRuns();
      expect(resumable.some((r) => r.id === cursorRunId)).toBe(false);

      for (const row of resumable) {
        const cr = store.getCursorRun(row.id);
        expect(cr?.status === "running").toBe(true);
        expect(row.runId.length).toBeGreaterThan(0);
      }
    },
  );

  test.prop([workflowStatusArbitrary, fc.boolean()], { numRuns: ITER })(
    "C3: resumable cloud rows appear iff cursor is running and run_id is persisted (any workflow status)",
    (workflowStatus, includeRunId) => {
      const wfId = seedWorkflow(workflowStatus);
      const cursorRunId = newCursorRunId();
      store.recordCursorRun({
        agentId: "bc-resume",
        artifactsDir: "/runs/resume",
        id: cursorRunId,
        runtime: "cloud",
        workflowRunId: wfId,
        ...(includeRunId ? { runId: "run-resume-002" } : {}),
      });

      const resumable = store.listResumableCloudCursorRuns();
      expect(resumable.some((r) => r.id === cursorRunId)).toBe(includeRunId);
    },
  );

  test.prop([fc.constantFrom("succeeded", "failed", "cancelled" as const)], { numRuns: ITER })(
    "C4: stale running cloud cursor on terminal workflow remains listable for core cleanup",
    (terminalWorkflowStatus) => {
      const wfId = seedWorkflow(terminalWorkflowStatus);
      const cursorRunId = newCursorRunId();
      store.recordCursorRun({
        agentId: "bc-stale",
        artifactsDir: "/runs/stale",
        id: cursorRunId,
        runId: "run-stale-001",
        runtime: "cloud",
        workflowRunId: wfId,
      });

      const resumable = store.listResumableCloudCursorRuns();
      expect(resumable.some((r) => r.id === cursorRunId)).toBe(true);
    },
  );
});

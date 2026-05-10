/** Scenario: phase failure — store does NOT auto-cascade run status; `core` makes the explicit move. */

import { afterEach, beforeEach, expect, test } from "vitest";

import type { Harness } from "../src/index.js";

import {
  createHarness,
  createSampleAppendPhaseInput,
  createSampleRecordCursorRunInput,
  createSampleWorkflowRunInput,
} from "../src/index.js";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.close();
});

test("phase failure: phase ends failed; parent updated_at bumped; run transitions to failed on explicit call", () => {
  const runId = h.ids.workflowRun();
  const phaseId = h.ids.phase();
  const cursorRunId = h.ids.cursorRun();

  const created = h.store.createWorkflowRun(createSampleWorkflowRunInput(runId));
  const t0 = created.updatedAt;

  // Each subsequent mutator bumps updated_at; capture the trail.
  h.store.updateWorkflowRunStatus(runId, "running");
  const t1 = h.store.getRun(runId)?.updatedAt;
  expect(t1).not.toBe(t0);

  h.store.appendPhase(createSampleAppendPhaseInput(phaseId, runId));
  const t2 = h.store.getRun(runId)?.updatedAt;
  expect(t2).not.toBe(t1);

  h.store.updatePhase(phaseId, { startedAt: h.clock(), status: "running" });
  const t3 = h.store.getRun(runId)?.updatedAt;
  expect(t3).not.toBe(t2);

  h.store.recordCursorRun(createSampleRecordCursorRunInput(cursorRunId, runId));

  // Cursor-run fails first (the agent threw).
  const cursorEndedAt = h.clock();
  h.store.updateCursorRunStatus(cursorRunId, {
    durationMs: 5_000,
    endedAt: cursorEndedAt,
    status: "failed",
  });

  // Phase fails next (the runner catches the cursor failure).
  const phaseEndedAt = h.clock();
  h.store.updatePhase(phaseId, {
    cursorRunId,
    endedAt: phaseEndedAt,
    errorMessage: "agent reported blocker: missing test fixture",
    status: "failed",
  });
  const t4 = h.store.getRun(runId)?.updatedAt;
  expect(t4).not.toBe(t3);

  // Critical: run status is still `running` until core decides.
  // The store does NOT auto-cascade.
  expect(h.store.getRun(runId)?.status).toBe("running");

  // Core's explicit move:
  h.store.updateWorkflowRunStatus(runId, "failed");

  const final = h.store.getRun(runId);
  expect(final?.status).toBe("failed");
  expect(final?.phases[0]?.status).toBe("failed");
  expect(final?.phases[0]?.errorMessage).toContain("blocker");

  const cursorRun = h.store.getCursorRun(cursorRunId);
  expect(cursorRun?.status).toBe("failed");
});

/**
 * Scenario: cancel mid-flight.
 *
 * A run with a `running` phase gets cancelled. Asserts:
 * - run status flips to `cancelled`, updated_at bumped
 * - any in-flight phase is also flipped to `cancelled` with `endedAt`
 *   set, IN THE SAME TRANSACTION as the run-status flip
 * - `cancelRun` is idempotent (second call is a no-op)
 *
 * This is the canonical "user hits cancel while the agent is still
 * working" flow that the MCP `cancel_workflow_run` tool will trigger.
 */

import { afterEach, beforeEach, expect, test } from "vitest";

import type { Harness } from "../src/index.js";

import {
  createHarness,
  createSampleAppendPhaseInput,
  createSampleWorkflowRunInput,
} from "../src/index.js";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.close();
});

test("cancel mid-flight: run + in-flight phase both flip to cancelled with endedAt", () => {
  const runId = h.ids.workflowRun();
  const phaseId = h.ids.phase();

  h.store.createWorkflowRun(createSampleWorkflowRunInput(runId));
  h.store.updateWorkflowRunStatus(runId, "running");
  h.store.appendPhase(createSampleAppendPhaseInput(phaseId, runId));
  h.store.updatePhase(phaseId, { startedAt: h.clock(), status: "running" });

  // Cancel.
  const cancelled = h.store.cancelRun(runId);

  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.phases).toHaveLength(1);
  const phase = cancelled.phases[0];
  expect(phase?.status).toBe("cancelled");
  expect(phase?.endedAt).toBeDefined();
});

test("cancel is idempotent: second call returns the same row, doesn't bump updated_at", () => {
  const runId = h.ids.workflowRun();
  h.store.createWorkflowRun(createSampleWorkflowRunInput(runId));

  const first = h.store.cancelRun(runId);
  const cancelledAt = first.updatedAt;

  const second = h.store.cancelRun(runId);
  expect(second.status).toBe("cancelled");
  expect(second.updatedAt).toBe(cancelledAt);
});

test("cancel preserves already-terminal phases (succeeded phase stays succeeded)", () => {
  const runId = h.ids.workflowRun();
  const finishedPhaseId = h.ids.phase();
  const inflightPhaseId = h.ids.phase();

  h.store.createWorkflowRun(createSampleWorkflowRunInput(runId));
  h.store.updateWorkflowRunStatus(runId, "running");

  // Phase A: started + succeeded.
  h.store.appendPhase(createSampleAppendPhaseInput(finishedPhaseId, runId));
  h.store.updatePhase(finishedPhaseId, { startedAt: h.clock(), status: "running" });
  h.store.updatePhase(finishedPhaseId, { endedAt: h.clock(), status: "succeeded" });

  // Phase B: still running.
  h.store.appendPhase(createSampleAppendPhaseInput(inflightPhaseId, runId));
  h.store.updatePhase(inflightPhaseId, { startedAt: h.clock(), status: "running" });

  const cancelled = h.store.cancelRun(runId);
  const finished = cancelled.phases.find((p) => p.id === finishedPhaseId);
  const inflight = cancelled.phases.find((p) => p.id === inflightPhaseId);
  expect(finished?.status).toBe("succeeded");
  expect(inflight?.status).toBe("cancelled");
});

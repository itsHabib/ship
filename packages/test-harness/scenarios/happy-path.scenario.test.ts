/** Scenario: happy-path workflow run — pending → running → succeeded across run + phase + cursor-run. */

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

test("happy path: pending → running → succeeded across run + phase + cursor-run", () => {
  const runId = h.ids.workflowRun();
  const phaseId = h.ids.phase();
  const cursorRunId = h.ids.cursorRun();

  // 1. Run lands in pending state.
  const created = h.store.createWorkflowRun(createSampleWorkflowRunInput(runId));
  expect(created.status).toBe("pending");
  expect(created.phases).toEqual([]);

  // 2. Run flips to running; nothing started yet at the phase level.
  const running = h.store.updateWorkflowRunStatus(runId, "running");
  expect(running.status).toBe("running");

  // 3. Phase appended in pending; parent updated_at bumped.
  h.store.appendPhase(createSampleAppendPhaseInput(phaseId, runId));

  // 4. Phase transitions to running with a startedAt.
  const startedAt = h.clock();
  h.store.updatePhase(phaseId, { startedAt, status: "running" });

  // 5. Cursor-run recorded; FK to the parent workflow_runs row holds.
  h.store.recordCursorRun(createSampleRecordCursorRunInput(cursorRunId, runId));

  // 6. Cursor-run finishes; durationMs is non-negative per the schema.
  const cursorEndedAt = h.clock();
  h.store.updateCursorRunStatus(cursorRunId, {
    durationMs: 60_000,
    endedAt: cursorEndedAt,
    status: "succeeded",
  });

  // 7. Phase finishes; carries the cursor-run id + structured output.
  const phaseEndedAt = h.clock();
  h.store.updatePhase(phaseId, {
    cursorRunId,
    endedAt: phaseEndedAt,
    outputJson: JSON.stringify({ filesChanged: ["src/hello.ts"] }),
    status: "succeeded",
  });

  // 8. Run reaches its terminal succeeded state.
  h.store.updateWorkflowRunStatus(runId, "succeeded");

  // Final assertions: getRun shows the hydrated terminal state.
  const final = h.store.getRun(runId);
  if (final === null) throw new Error("workflow run vanished after terminal write");
  expect(final.status).toBe("succeeded");
  expect(final.phases).toHaveLength(1);
  const phase = final.phases[0];
  if (phase === undefined) throw new Error("expected one phase on terminal run");
  expect(phase.status).toBe("succeeded");
  expect(phase.cursorRunId).toBe(cursorRunId);
  expect(phase.startedAt).toBe(startedAt);
  expect(phase.endedAt).toBe(phaseEndedAt);
  expect(phase.outputJson).toContain("src/hello.ts");

  // Cursor-run retrievable independently.
  const cursorRun = h.store.getCursorRun(cursorRunId);
  if (cursorRun === null) throw new Error("cursor run row vanished");
  expect(cursorRun.status).toBe("succeeded");
  expect(cursorRun.durationMs).toBe(60_000);
  expect(cursorRun.endedAt).toBe(cursorEndedAt);
});

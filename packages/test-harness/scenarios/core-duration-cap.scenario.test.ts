/**
 * L2 scenario: `policy.maxRunDurationMs` enforcement against a cloud run
 * whose agent never reaches terminal. Fake timers drive the cap window;
 * the FakeCursorRunner scripts a run that streams nothing and never
 * settles, so the only way the workflow leaves `running` is the cap guard.
 */

import type { FakeCursorScript } from "@ship/cursor-runner/test/fake";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { CLOUD_WORKTREE_SENTINEL, DEFAULT_WORKFLOW_POLICY } from "@ship/workflow";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createMemoryShipFs } from "../../core/src/fs/memory.js";
import { createShipService } from "../../core/src/service.js";
import { createTestClock } from "../src/index.js";

const RUNS_DIR = "/state/runs";
const WORKDIR = "/work/wt/cap";
const REPO_URL = "https://github.com/owner/repo";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// One assistant event behind an hour-long (faked) delay: the run streams
// nothing and never reaches terminal on its own.
function neverTerminatingScript(): FakeCursorScript {
  return {
    delayMsBetweenEvents: HOUR_MS,
    events: [
      {
        type: "assistant",
        agent_id: "agent-hung",
        run_id: "run-hung",
        message: { role: "assistant", content: [{ type: "text", text: "..." }] },
      },
    ] as never,
    result: { branches: [], durationMs: 0, status: "succeeded" },
  };
}

// Flushes real macrotasks (`setImmediate` is not faked) until `probe`
// holds, letting the background ship continuation advance to the point
// where the cap timer is armed without advancing the faked clock.
async function flushUntil(probe: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (probe()) return;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`flushUntil: ${label} never became true`);
}

beforeEach(() => {
  // setImmediate / setInterval / Date stay real: the flush helper and the
  // event pump must keep working while only the cap window is virtual.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

test("fresh cloud run that never terminates is failed timeout-near-cap at the policy cap", async () => {
  const fs = createMemoryShipFs();
  await fs.mkdir(`${WORKDIR}/docs`, { recursive: true });
  await fs.writeFile(`${WORKDIR}/docs/task.md`, "# Hang forever");
  const store = createStore({
    clock: createTestClock("2026-06-10T00:00:00.000Z"),
    dbPath: ":memory:",
  });
  const cloudCursor = new FakeCursorRunner();
  cloudCursor.enqueue(neverTerminatingScript());

  const service = createShipService({
    clock: createTestClock("2026-06-10T00:00:00.000Z"),
    config: {
      cloudCursor,
      cursor: new FakeCursorRunner(),
      defaultModel: { id: "composer-2.5" },
      runsDir: RUNS_DIR,
    },
    fs,
    store,
  });

  const started = await service.startShip({
    cloud: { repos: [{ url: REPO_URL }] },
    docPath: "docs/task.md",
    runtime: "cloud",
    workdir: WORKDIR,
  });
  expect(started.status).toBe("running");

  // Two armed fake timers = the script's never-ending delay + the cap guard.
  await flushUntil(
    () => cloudCursor.calls.length === 1 && vi.getTimerCount() >= 2,
    "cloud run dispatched and cap guard armed",
  );

  // One tick short of the cap the run is still live.
  await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLICY.maxRunDurationMs - 1);
  expect((await service.getRun(started.workflowRunId))?.status).toBe("running");

  await vi.advanceTimersByTimeAsync(1);
  await service.drainBackground();

  const row = await service.getRun(started.workflowRunId);
  expect(row?.status).toBe("failed");
  expect(row?.failureCategory).toBe("timeout-near-cap");
  expect(row?.phases[0]?.failureCategory).toBe("timeout-near-cap");
  expect(row?.phases[0]?.errorMessage).toContain("timeout-near-cap");
  expect(row?.maxRunDurationMs).toBe(DEFAULT_WORKFLOW_POLICY.maxRunDurationMs);

  const resultJson = JSON.parse(
    await fs.readFile(`${RUNS_DIR}/${started.workflowRunId}/result.json`, "utf-8"),
  ) as Record<string, unknown>;
  expect(resultJson["status"]).toBe("failed");
  expect(resultJson["failureCategory"]).toBe("timeout-near-cap");
  expect(resultJson["durationMs"]).toBe(DEFAULT_WORKFLOW_POLICY.maxRunDurationMs);

  // Cancel reached the runner: the script's pending delay was cleared
  // along with the cap guard's own timer.
  expect(vi.getTimerCount()).toBe(0);

  store.close();
});

test("resumed cloud run only gets the remaining cap budget, not a fresh window", async () => {
  const WORKFLOW_RUN_ID = "wf_00000000000000000000000020";
  const PHASE_ID = "ph_00000000000000000000000020";
  const CURSOR_RUN_ID = "cr_00000000000000000000000020";
  const T0 = "2026-06-10T00:00:00.000Z";

  const fs = createMemoryShipFs();
  await fs.mkdir(`${RUNS_DIR}/${WORKFLOW_RUN_ID}`, { recursive: true });
  const store = createStore({ clock: createTestClock(T0), dbPath: ":memory:" });

  store.createWorkflowRun({
    baseRef: "main",
    docPath: "docs/task.md",
    id: WORKFLOW_RUN_ID,
    policy: { ...DEFAULT_WORKFLOW_POLICY },
    repo: "ship",
    worktree: {
      baseRef: "main",
      branch: CLOUD_WORKTREE_SENTINEL,
      name: CLOUD_WORKTREE_SENTINEL,
      path: CLOUD_WORKTREE_SENTINEL,
      repo: "ship",
    },
  });
  store.appendPhase({
    id: PHASE_ID,
    inputJson: JSON.stringify({ cloud: { repos: [{ url: REPO_URL }] }, docPath: "docs/task.md" }),
    kind: "implement",
    workflowRunId: WORKFLOW_RUN_ID,
  });
  store.markRunStarted(WORKFLOW_RUN_ID, PHASE_ID, T0);
  store.updatePhase(PHASE_ID, { cursorRunId: CURSOR_RUN_ID, status: "running" });
  store.recordCursorRun({
    agentId: "bc-l2-cap-0001",
    artifactsDir: `${RUNS_DIR}/${WORKFLOW_RUN_ID}`,
    id: CURSOR_RUN_ID,
    model: { id: "composer-2.5" },
    runId: "run-l2-cap-0001",
    runtime: "cloud",
    workflowRunId: WORKFLOW_RUN_ID,
  });

  const cloudCursor = new FakeCursorRunner();
  cloudCursor.enqueueAttach(neverTerminatingScript());

  // Restart 20 minutes into a 30-minute cap: the resumed run has only
  // ~10 minutes of budget left.
  const restarted = createShipService({
    clock: createTestClock("2026-06-10T00:20:00.000Z"),
    config: {
      cloudCursor,
      cursor: new FakeCursorRunner(),
      defaultModel: { id: "composer-2.5" },
      runsDir: RUNS_DIR,
    },
    fs,
    store,
  });
  // NOTE: `resumeReady()` resolves only when resumed runs reach terminal,
  // which here requires the cap to fire first — so don't await it yet.

  await flushUntil(
    () => cloudCursor.attachCalls.length === 1 && vi.getTimerCount() >= 2,
    "cloud run re-attached and cap guard armed",
  );

  // Just short of the ~10-minute remaining budget: still live.
  await vi.advanceTimersByTimeAsync(9 * MINUTE_MS);
  expect((await restarted.getRun(WORKFLOW_RUN_ID))?.status).toBe("running");

  // Crossing the remaining window (with a second of margin for the test
  // clocks' per-call step) flips the run, far before the full 30-minute
  // cap a fresh window would have granted.
  await vi.advanceTimersByTimeAsync(MINUTE_MS + 1000);
  await restarted.drainBackground();

  const row = await restarted.getRun(WORKFLOW_RUN_ID);
  expect(row?.status).toBe("failed");
  expect(row?.failureCategory).toBe("timeout-near-cap");
  expect(vi.getTimerCount()).toBe(0);

  store.close();
});

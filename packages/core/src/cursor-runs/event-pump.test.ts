/**
 * Unit tests for the cloud-run event pump heartbeat.
 */

import { createStore } from "@ship/store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_EVENT_PUMP_INTERVAL_MS, startEventPump, stopEventPump } from "./event-pump.js";

function deterministicClock(start: string, stepMs = 1000): () => string {
  let t = new Date(start).getTime();
  return () => {
    const out = new Date(t).toISOString();
    t += stepMs;
    return out;
  };
}

describe("startEventPump", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createStore({
      clock: deterministicClock("2026-05-23T00:00:00.000Z"),
      dbPath: ":memory:",
    });
    store.createWorkflowRun({
      baseRef: "main",
      docPath: "docs/task.md",
      id: "wf_test_001",
      policy: { agentTimeoutMs: 1, baseRef: "main", maxRunDurationMs: 1 },
      repo: "ship",
      worktree: {
        baseRef: "main",
        branch: "feat",
        name: "feat",
        path: "/wt",
        repo: "ship",
      },
    });
    store.updateWorkflowRunStatus("wf_test_001", "running");
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("heartbeat bumps workflow_runs.updated_at on the interval", () => {
    const before = store.getRun("wf_test_001")?.updatedAt;
    const pump = startEventPump({
      intervalMs: 5_000,
      store,
      workflowRunId: "wf_test_001",
    });

    vi.advanceTimersByTime(5_000);
    const afterFirst = store.getRun("wf_test_001")?.updatedAt;
    expect(afterFirst).not.toBe(before);

    vi.advanceTimersByTime(5_000);
    const afterSecond = store.getRun("wf_test_001")?.updatedAt;
    expect(afterSecond).not.toBe(afterFirst);

    pump.stop();
  });

  test("manual heartbeat() bumps updated_at immediately", () => {
    const before = store.getRun("wf_test_001")?.updatedAt;
    const pump = startEventPump({ store, workflowRunId: "wf_test_001" });
    pump.heartbeat();
    expect(store.getRun("wf_test_001")?.updatedAt).not.toBe(before);
    pump.stop();
  });

  test("stop() clears the timer — no further bumps after stop", () => {
    const pump = startEventPump({
      intervalMs: 1_000,
      store,
      workflowRunId: "wf_test_001",
    });
    vi.advanceTimersByTime(1_000);
    const afterTick = store.getRun("wf_test_001")?.updatedAt;
    pump.stop();
    vi.advanceTimersByTime(10_000);
    expect(store.getRun("wf_test_001")?.updatedAt).toBe(afterTick);
  });

  test("stopEventPump is an alias for handle.stop()", () => {
    const pump = startEventPump({
      intervalMs: 1_000,
      store,
      workflowRunId: "wf_test_001",
    });
    vi.advanceTimersByTime(1_000);
    const afterTick = store.getRun("wf_test_001")?.updatedAt;
    stopEventPump(pump);
    vi.advanceTimersByTime(10_000);
    expect(store.getRun("wf_test_001")?.updatedAt).toBe(afterTick);
  });

  test("defaults to 30s interval", () => {
    expect(DEFAULT_EVENT_PUMP_INTERVAL_MS).toBe(30_000);
  });
});

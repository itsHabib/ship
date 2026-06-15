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

  test("initial heartbeat fires at startup (short-lived runs still bump)", () => {
    const before = store.getRun("wf_test_001")?.updatedAt;
    const pump = startEventPump({
      intervalMs: 60_000, // long interval; only the initial bump matters here
      store,
      workflowRunId: "wf_test_001",
    });
    // No timer advance — the initial heartbeat at start should already
    // have bumped updated_at, even though the first interval tick is
    // 60s away.
    const afterStart = store.getRun("wf_test_001")?.updatedAt;
    expect(afterStart).not.toBe(before);
    pump.stop();
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

  test("heartbeat timer is unref'd so it does not keep the process alive alone", () => {
    const unref = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((handler, timeout) => {
        const timer = realSetInterval(handler, timeout);
        return Object.assign(timer, { unref });
      });

    try {
      const pump = startEventPump({ store, workflowRunId: "wf_test_001" });
      expect(unref).toHaveBeenCalledOnce();
      pump.stop();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test("heartbeat error self-stops the pump (no further bumps, no uncaught throw)", () => {
    const pump = startEventPump({
      intervalMs: 1_000,
      store,
      workflowRunId: "wf_does_not_exist",
    });
    // First tick: store.touchWorkflowRunUpdatedAt throws because the row
    // doesn't exist. The pump must swallow + self-stop, not propagate.
    expect(() => {
      vi.advanceTimersByTime(1_000);
    }).not.toThrow();
    // After self-stop, a manual heartbeat() is a no-op too.
    expect(() => {
      pump.heartbeat();
    }).not.toThrow();
    // Subsequent timer ticks don't re-throw either.
    expect(() => {
      vi.advanceTimersByTime(10_000);
    }).not.toThrow();
    pump.stop();
  });

  test("heartbeat error on a closed store stops the pump (no further bumps, no throw)", () => {
    const pump = startEventPump({
      intervalMs: 1_000,
      store,
      workflowRunId: "wf_test_001",
    });
    vi.advanceTimersByTime(1_000);
    const afterFirstTick = store.getRun("wf_test_001")?.updatedAt;
    expect(afterFirstTick).toBeDefined();

    // Close the store mid-pump — the next heartbeat throws (DB closed),
    // and the pump must swallow + self-stop. Re-create a fresh store in
    // the afterEach reset; tests own that bookkeeping.
    store.close();

    expect(() => {
      vi.advanceTimersByTime(1_000);
    }).not.toThrow();
    expect(() => {
      pump.heartbeat();
    }).not.toThrow();
    pump.stop();
    // Reopen so afterEach close() doesn't double-close.
    store = createStore({
      clock: deterministicClock("2026-05-23T00:00:00.000Z"),
      dbPath: ":memory:",
    });
  });
});

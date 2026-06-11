/**
 * Unit tests for `policy.maxRunDurationMs` enforcement over the cursor-run
 * start → terminal sequence.
 */

import type { CursorRunHandle, CursorRunResult } from "@ship/cursor-runner";
import type { Mock } from "vitest";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CursorRunStartTimedOutError } from "../errors.js";
import { MIN_RESUMED_CAP_WINDOW_MS, runWithDurationCap } from "./duration-cap.js";

const CAP_MS = 30 * 60 * 1000;

const succeededResult: CursorRunResult = {
  branches: [],
  durationMs: 1234,
  status: "succeeded",
  summary: "done",
};

function pendingForever<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* intentionally pending forever */
  });
}

function fakeHandle(result: Promise<CursorRunResult>): {
  cancel: Mock<() => Promise<void>>;
  handle: CursorRunHandle;
} {
  const cancel = vi.fn(() => Promise.resolve());
  return { cancel, handle: { agentId: "agent-x", cancel, result, runId: "run-x" } };
}

describe("runWithDurationCap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("passes the runner result through when it settles before the cap", async () => {
    const { cancel, handle } = fakeHandle(Promise.resolve(succeededResult));
    const onHandle = vi.fn();
    const out = await runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      onHandle,
      start: () => Promise.resolve(handle),
    });
    expect(out).toBe(succeededResult);
    expect(onHandle).toHaveBeenCalledTimes(1);
    expect(onHandle).toHaveBeenCalledWith(handle);
    expect(cancel).not.toHaveBeenCalled();
    // The cap timer is cleared once the race settles.
    expect(vi.getTimerCount()).toBe(0);
  });

  test("propagates a result rejection unchanged and clears the timer", async () => {
    const boom = new Error("runner exploded");
    const { cancel, handle } = fakeHandle(Promise.reject(boom));
    await expect(
      runWithDurationCap({
        maxRunDurationMs: CAP_MS,
        onHandle: () => undefined,
        start: () => Promise.resolve(handle),
      }),
    ).rejects.toBe(boom);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("propagates a start rejection unchanged", async () => {
    const boom = new Error("Agent.create failed");
    const onHandle = vi.fn();
    await expect(
      runWithDurationCap({
        maxRunDurationMs: CAP_MS,
        onHandle,
        start: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
    expect(onHandle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cap expiry after the handle exists cancels the run and synthesizes a failed terminal", async () => {
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(CAP_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBe(CAP_MS);
    expect(out.branches).toEqual([]);
    expect(out.errorMessage).toContain("maxRunDurationMs");
    // No classificationEvents / sdkTerminalStatus — classification must
    // land on timeout-near-cap from durationMs >= cap alone.
    expect(out.classificationEvents).toBeUndefined();
    expect(out.sdkTerminalStatus).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cap expiry before the handle exists rejects CursorRunStartTimedOutError", async () => {
    const onHandle = vi.fn();
    let resolveStart!: (h: CursorRunHandle) => void;
    const start = new Promise<CursorRunHandle>((resolve) => {
      resolveStart = resolve;
    });
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      onHandle,
      start: () => start,
    });
    // Attach the rejection handler BEFORE advancing the clock — the cap
    // rejects mid-tick and an unobserved rejection trips vitest's
    // unhandled-error detector.
    const rejection = expect(pending).rejects.toBeInstanceOf(CursorRunStartTimedOutError);
    await vi.advanceTimersByTimeAsync(CAP_MS);
    await rejection;
    expect(onHandle).not.toHaveBeenCalled();

    // A handle arriving after expiry is cancelled, never registered.
    const { cancel, handle } = fakeHandle(pendingForever());
    resolveStart(handle);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onHandle).not.toHaveBeenCalled();
  });

  test("a rejecting cancel is swallowed; the synthetic terminal still stands", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel round-trip failed")));
    const handle: CursorRunHandle = {
      agentId: "agent-x",
      cancel,
      result: pendingForever(),
      runId: "run-x",
    };
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(CAP_MS);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("resume elapsed shrinks the window to the remaining budget", async () => {
    const elapsedMs = 20 * 60 * 1000;
    const { handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      elapsedMs,
      maxRunDurationMs: CAP_MS,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(CAP_MS - elapsedMs);
    const out = await pending;
    expect(out.status).toBe("failed");
    // Synthetic duration reflects total wall time, not just this window.
    expect(out.durationMs).toBe(CAP_MS);
  });

  test("resume with the budget already spent still gets the grace window", async () => {
    const elapsedMs = 2 * CAP_MS;
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      elapsedMs,
      maxRunDurationMs: CAP_MS,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(MIN_RESUMED_CAP_WINDOW_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBe(elapsedMs + MIN_RESUMED_CAP_WINDOW_MS);
  });

  test("the grace window never exceeds the configured cap", async () => {
    const capMs = 10_000; // smaller than the 60s grace floor
    const { handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      elapsedMs: 9_000,
      maxRunDurationMs: capMs,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    // Window clamps to the cap itself (10s), not to the 60s floor.
    await vi.advanceTimersByTimeAsync(capMs);
    const out = await pending;
    expect(out.status).toBe("failed");
  });

  test("a result landing inside the grace window beats the synthetic terminal", async () => {
    let resolveRunner!: (r: CursorRunResult) => void;
    const runner = new Promise<CursorRunResult>((resolve) => {
      resolveRunner = resolve;
    });
    const { cancel, handle } = fakeHandle(runner);
    const pending = runWithDurationCap({
      elapsedMs: 2 * CAP_MS,
      maxRunDurationMs: CAP_MS,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(MIN_RESUMED_CAP_WINDOW_MS - 1);
    resolveRunner(succeededResult);
    const out = await pending;
    expect(out).toBe(succeededResult);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

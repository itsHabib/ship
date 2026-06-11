/**
 * Unit tests for `policy.maxRunDurationMs` enforcement over a cursor-run
 * terminal promise.
 */

import type { CursorRunResult } from "@ship/cursor-runner";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { awaitResultWithDurationCap, MIN_RESUMED_CAP_WINDOW_MS } from "./duration-cap.js";

const CAP_MS = 30 * 60 * 1000;

const succeededResult: CursorRunResult = {
  branches: [],
  durationMs: 1234,
  status: "succeeded",
  summary: "done",
};

function neverResolves(): Promise<CursorRunResult> {
  return new Promise<CursorRunResult>(() => {
    /* intentionally pending forever */
  });
}

describe("awaitResultWithDurationCap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("passes the runner result through when it settles before the cap", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const out = await awaitResultWithDurationCap({
      cancel,
      maxRunDurationMs: CAP_MS,
      result: Promise.resolve(succeededResult),
    });
    expect(out).toBe(succeededResult);
    expect(cancel).not.toHaveBeenCalled();
    // The cap timer is cleared once the race settles.
    expect(vi.getTimerCount()).toBe(0);
  });

  test("propagates a runner rejection unchanged and clears the timer", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const boom = new Error("runner exploded");
    await expect(
      awaitResultWithDurationCap({
        cancel,
        maxRunDurationMs: CAP_MS,
        result: Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cap expiry cancels the run and synthesizes a failed terminal at the cap", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const pending = awaitResultWithDurationCap({
      cancel,
      maxRunDurationMs: CAP_MS,
      result: neverResolves(),
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

  test("a rejecting cancel is swallowed; the synthetic terminal still stands", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel round-trip failed")));
    const pending = awaitResultWithDurationCap({
      cancel,
      maxRunDurationMs: CAP_MS,
      result: neverResolves(),
    });
    await vi.advanceTimersByTimeAsync(CAP_MS);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("resume elapsed shrinks the window to the remaining budget", async () => {
    const elapsedMs = 20 * 60 * 1000;
    const cancel = vi.fn(() => Promise.resolve());
    const pending = awaitResultWithDurationCap({
      cancel,
      elapsedMs,
      maxRunDurationMs: CAP_MS,
      result: neverResolves(),
    });
    await vi.advanceTimersByTimeAsync(CAP_MS - elapsedMs);
    const out = await pending;
    expect(out.status).toBe("failed");
    // Synthetic duration reflects total wall time, not just this window.
    expect(out.durationMs).toBe(CAP_MS);
  });

  test("resume with the budget already spent still gets the grace window", async () => {
    const elapsedMs = 2 * CAP_MS;
    const cancel = vi.fn(() => Promise.resolve());
    const pending = awaitResultWithDurationCap({
      cancel,
      elapsedMs,
      maxRunDurationMs: CAP_MS,
      result: neverResolves(),
    });
    await vi.advanceTimersByTimeAsync(MIN_RESUMED_CAP_WINDOW_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBe(elapsedMs + MIN_RESUMED_CAP_WINDOW_MS);
  });

  test("a result landing inside the grace window beats the synthetic terminal", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    let resolveRunner!: (r: CursorRunResult) => void;
    const runner = new Promise<CursorRunResult>((resolve) => {
      resolveRunner = resolve;
    });
    const pending = awaitResultWithDurationCap({
      cancel,
      elapsedMs: 2 * CAP_MS,
      maxRunDurationMs: CAP_MS,
      result: runner,
    });
    await vi.advanceTimersByTimeAsync(MIN_RESUMED_CAP_WINDOW_MS - 1);
    resolveRunner(succeededResult);
    const out = await pending;
    expect(out).toBe(succeededResult);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

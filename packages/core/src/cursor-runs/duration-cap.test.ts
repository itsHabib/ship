/**
 * Unit tests for `policy.maxRunDurationMs` enforcement over the cursor-run
 * start → terminal sequence.
 */

import type { AgentRunHandle, AgentRunResult } from "@ship/cursor-runner";
import type { Mock } from "vitest";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CursorRunStartTimedOutError } from "../errors.js";
import {
  type DurationCapRunArgs,
  MAX_CAP_REARMS,
  MAX_TIMER_DELAY_MS,
  MIN_RESUMED_CAP_WINDOW_MS,
  runWithDurationCap,
} from "./duration-cap.js";

const CAP_MS = 30 * 60 * 1000;

// vitest fake timers advance `Date` but not `performance.now`, so tests drive
// the cap's monotonic clock off `Date.now()` — it moves in step with
// `advanceTimersByTimeAsync`, exactly as the production monotonic clock would
// on a machine whose clock isn't jumping. Individual tests override
// `monotonicClock` to simulate a suspend / jump (timer fires, monotonic doesn't).
function runCap(args: DurationCapRunArgs): Promise<AgentRunResult> {
  return runWithDurationCap({ monotonicClock: () => Date.now(), ...args });
}

const succeededResult: AgentRunResult = {
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

function fakeHandle(result: Promise<AgentRunResult>): {
  cancel: Mock<() => Promise<void>>;
  handle: AgentRunHandle;
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
    const out = await runCap({
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
      runCap({
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
      runCap({
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
    const pending = runCap({
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
    let resolveStart!: (h: AgentRunHandle) => void;
    const start = new Promise<AgentRunHandle>((resolve) => {
      resolveStart = resolve;
    });
    const pending = runCap({
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
    const handle: AgentRunHandle = {
      agentId: "agent-x",
      cancel,
      result: pendingForever(),
      runId: "run-x",
    };
    const pending = runCap({
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
    const pending = runCap({
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
    const pending = runCap({
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
    const pending = runCap({
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

  // Regression: the race loser settling late must not surface as an
  // unhandled rejection (vitest fails the suite on one). Each case drives the
  // loser to reject AFTER the race resolved, then flushes microtasks.
  test("post-handle: a late handle.result rejection after the synthetic verdict is swallowed", async () => {
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<AgentRunResult>((_resolve, reject) => {
      rejectResult = reject;
    });
    const { cancel, handle } = fakeHandle(result);
    const pending = runCap({
      maxRunDurationMs: CAP_MS,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(CAP_MS);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
    // The runner's result rejects post-cancel — the loser of the race.
    rejectResult(new Error("runner rejected after cap cancel"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  });

  test("pre-handle: a late start() rejection after CursorRunStartTimedOutError is swallowed", async () => {
    const onHandle = vi.fn();
    let rejectStart!: (e: unknown) => void;
    const start = new Promise<AgentRunHandle>((_resolve, reject) => {
      rejectStart = reject;
    });
    const pending = runCap({
      maxRunDurationMs: CAP_MS,
      onHandle,
      start: () => start,
    });
    const rejection = expect(pending).rejects.toBeInstanceOf(CursorRunStartTimedOutError);
    await vi.advanceTimersByTimeAsync(CAP_MS);
    await rejection;
    // start() (a hung SDK call) rejects long after the cap already won.
    rejectStart(new Error("Agent.create finally errored"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(onHandle).not.toHaveBeenCalled();
  });

  test("a synchronous throw from start() rejects and still clears the cap timer", async () => {
    const boom = new Error("runner.run threw synchronously");
    const onHandle = vi.fn();
    await expect(
      runCap({
        maxRunDurationMs: CAP_MS,
        onHandle,
        start: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(onHandle).not.toHaveBeenCalled();
    // The cap timer was armed before start() threw; the finally must clear it.
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a cap above Node's timer max re-arms past the clamp instead of firing early", async () => {
    const hugeCap = MAX_TIMER_DELAY_MS + 5_000_000; // beyond the 32-bit setTimeout ceiling
    const { handle } = fakeHandle(pendingForever());
    const pending = runCap({
      maxRunDurationMs: hugeCap,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    // A naive (unclamped) delay would have been coerced to 1ms by Node and
    // fired here — assert it did NOT.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(1);
    // The clamped ceiling fires, but real (monotonic) elapsed hasn't reached the
    // cap, so it re-arms for the remainder rather than expiring early.
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(vi.getTimerCount()).toBe(1);
    // Advancing the remainder reaches the real cap → synthetic terminal, whose
    // duration reflects the configured cap, not the clamp.
    await vi.advanceTimersByTimeAsync(hugeCap - MAX_TIMER_DELAY_MS - 10_000);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBe(hugeCap);
  });

  test("a result landing inside the grace window beats the synthetic terminal", async () => {
    let resolveRunner!: (r: AgentRunResult) => void;
    const runner = new Promise<AgentRunResult>((resolve) => {
      resolveRunner = resolve;
    });
    const { cancel, handle } = fakeHandle(runner);
    const pending = runCap({
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

  // The keystone: a timer that fires after a host suspend / wall-clock jump —
  // when no real (monotonic) run time elapsed — must NOT synthesize a
  // timeout-near-cap. It re-arms for the remaining window instead.
  test("a timer misfire (suspend / clock jump) re-arms instead of failing", async () => {
    let mono = 0;
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runCap({
      maxRunDurationMs: CAP_MS,
      // Monotonic clock stays at 0 across the first fire — the event-loop timer
      // fired (wall time jumped) but no real run time passed.
      monotonicClock: () => mono,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(CAP_MS);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // re-armed, not resolved
    // Now let real (monotonic) time reach the window; the re-armed timer expires.
    mono = CAP_MS;
    await vi.advanceTimersByTimeAsync(CAP_MS);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBe(CAP_MS);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("re-arming is bounded by MAX_CAP_REARMS (runaway backstop)", async () => {
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runCap({
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => 0, // frozen: every fire looks like a misfire
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    // A frozen monotonic clock would re-arm forever; the backstop forces expiry.
    // Each of the first MAX_CAP_REARMS fires re-arms (another full window)...
    for (let i = 0; i < MAX_CAP_REARMS; i += 1) {
      await vi.advanceTimersByTimeAsync(CAP_MS);
      expect(cancel).not.toHaveBeenCalled();
    }
    // ...the next fire hits the backstop and expires despite the frozen clock.
    await vi.advanceTimersByTimeAsync(CAP_MS);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

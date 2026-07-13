/**
 * Unit tests for `policy.maxRunDurationMs` enforcement over the cursor-run
 * start → terminal sequence.
 */

import type { AgentRunHandle, AgentRunResult } from "@ship/cursor-runner";
import type { Mock } from "vitest";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CursorRunStartTimedOutError } from "../errors.js";
import {
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  type DurationCapHandle,
  type DurationCapRunArgs,
  MAX_CAP_REARMS,
  MAX_TIMER_DELAY_MS,
  MIN_RESUMED_CAP_WINDOW_MS,
  runWithDurationCap,
} from "./duration-cap.js";

const CAP_MS = 30 * 60 * 1000;

// A backstop that dwarfs the inactivity window, so the local-path tests below
// that assert the WALL-CLOCK backstop (`timeout-near-cap`) aren't pre-empted
// by the inactivity watchdog. Watchdog-specific tests set their own small
// `inactivityTimeoutMs` explicitly.
const NO_INACTIVITY_CAP_MS = 10 * 365 * 24 * 60 * 60 * 1000;

// vitest fake timers advance `Date` but not `performance.now`, so tests drive
// the cap's monotonic clock off `Date.now()` — it moves in step with
// `advanceTimersByTimeAsync`, exactly as the production monotonic clock would
// on a machine whose clock isn't jumping. Individual tests override
// `monotonicClock` to simulate a suspend / jump (timer fires, monotonic doesn't).
//
// `inactivityTimeoutMs` defaults to a decade here so the pre-existing backstop
// suite keeps measuring the wall-clock cap; the watchdog cases pass their own.
function runCap(args: DurationCapRunArgs): Promise<AgentRunResult> {
  return runWithDurationCap({
    inactivityTimeoutMs: NO_INACTIVITY_CAP_MS,
    monotonicClock: () => Date.now(),
    ...args,
  });
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
    // fired here — assert it did NOT. Two timers are armed: the backstop and
    // the always-on inactivity watchdog (itself clamped, far from firing here).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(2);
    // The clamped ceiling fires, but real (monotonic) elapsed hasn't reached the
    // cap, so it re-arms for the remainder rather than expiring early.
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(vi.getTimerCount()).toBe(2);
    // Advancing the remainder reaches the real cap → synthetic terminal, whose
    // duration reflects the configured cap, not the clamp.
    await vi.advanceTimersByTimeAsync(hugeCap - MAX_TIMER_DELAY_MS - 10_000);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBe(hugeCap);
  });

  // A cap beyond Node's timer ceiling is served as clamped segments. On a
  // healthy clock each segment boundary is NOT a suspend misfire, so it must
  // re-arm silently — no "host suspend / clock jump" warning, no misfire budget
  // spent. Regression for the segment-vs-misfire conflation.
  test("a clamped segment of a huge cap re-arms without a suspend-misfire warning", async () => {
    const warn = vi.fn();
    const log = { warn } as unknown as NonNullable<DurationCapRunArgs["log"]>;
    const hugeCap = 3 * MAX_TIMER_DELAY_MS; // three clamped segments on a healthy clock
    const { handle } = fakeHandle(pendingForever());
    const pending = runCap({
      log,
      maxRunDurationMs: hugeCap,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    // Cross two full clamped segments; the clock is healthy at each boundary.
    await vi.advanceTimersByTimeAsync(2 * MAX_TIMER_DELAY_MS);
    const suspendWarnings = warn.mock.calls.filter(
      ([, msg]) => typeof msg === "string" && msg.includes("host suspend"),
    );
    expect(suspendWarnings).toEqual([]);
    // Backstop armed for the third segment + the always-on inactivity watchdog.
    expect(vi.getTimerCount()).toBe(2);
    // The final segment reaches the real window → synthetic timeout terminal.
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
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
    // Backstop re-armed (not resolved) + the always-on inactivity watchdog.
    expect(vi.getTimerCount()).toBe(2);
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

  // ── Inactivity watchdog (the liveness rework) ──────────────────────────────
  // These pass their own (small) `inactivityTimeoutMs` rather than the decade
  // default `runCap` injects, so they exercise the watchdog rather than the
  // wall-clock backstop. The backstop is set far above the inactivity window so
  // it can't pre-empt the watchdog verdict.

  const INACTIVITY_MS = 5 * 60 * 1000;
  const BIG_BACKSTOP_MS = 24 * 60 * 60 * 1000; // dwarfs the inactivity window

  // Feed a stream event into the cap's hook, captured via `onCapReady` exactly
  // as `service.ts` wires it (onEvent → wireCapStreamFold → onProviderStreamEvent).
  function withCapHooks(): {
    readonly onCapReady: (h: DurationCapHandle) => void;
    emit: () => void;
  } {
    let hooks: DurationCapHandle | undefined;
    return {
      onCapReady: (h) => {
        hooks = h;
      },
      emit: () => hooks?.onProviderStreamEvent(Date.now()),
    };
  }

  test("an actively-emitting run is never cancelled on wall-clock alone (below the backstop)", async () => {
    const cap = withCapHooks();
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      inactivityTimeoutMs: INACTIVITY_MS,
      maxRunDurationMs: BIG_BACKSTOP_MS,
      monotonicClock: () => Date.now(),
      onCapReady: cap.onCapReady,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    // Emit an event every 4 min for 40 min — well past a single inactivity
    // window, but each event resets the watchdog before it can fire. Total
    // wall-clock (40 min) also far exceeds today's old 30-min fixed cap.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      cap.emit();
    }
    expect(cancel).not.toHaveBeenCalled();
    // Both timers still armed (backstop + watchdog); the run lives on.
    expect(vi.getTimerCount()).toBe(2);
    // Clean up the still-pending race so vitest doesn't flag a dangling timer.
    vi.clearAllTimers();
    void pending.catch(() => undefined);
  });

  test("a run silent for inactivityTimeoutMs is cancelled and classified as a stall", async () => {
    const cap = withCapHooks();
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      inactivityTimeoutMs: INACTIVITY_MS,
      maxRunDurationMs: BIG_BACKSTOP_MS,
      monotonicClock: () => Date.now(),
      onCapReady: cap.onCapReady,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    // One event, then silence. Just under the window: still alive.
    cap.emit();
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    // Cross the window: the watchdog fires long before the 24h backstop.
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(out.status).toBe("failed");
    // Stamped verbatim by the cap so `classifyFailedRun` reports a stall rather
    // than the duration-based `timeout-near-cap` (a silent run never reached the
    // backstop, so there's no `durationMs >= cap` signal to classify on).
    expect(out.failureCategory).toBe("agent-collapse-on-running-tool");
    expect(out.errorMessage).toContain("inactivityTimeoutMs");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("a simulated suspension (clock jump, no events, then events resume) does NOT cancel", async () => {
    let mono = 0;
    const cap = withCapHooks();
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      inactivityTimeoutMs: INACTIVITY_MS,
      maxRunDurationMs: BIG_BACKSTOP_MS,
      // Monotonic clock frozen across the suspend: the event-loop timer fires
      // (wall jumped) but no real run time elapsed, so the watchdog re-arms
      // rather than declaring a stall.
      monotonicClock: () => mono,
      onCapReady: cap.onCapReady,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    cap.emit();
    // The host sleeps: wall clock jumps a full inactivity window, monotonic
    // stays put. The watchdog timer fires but sees zero real silence → re-arm.
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    expect(cancel).not.toHaveBeenCalled();
    // Events resume on wake; monotonic starts moving again from the wake point.
    mono = 1;
    cap.emit();
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    vi.clearAllTimers();
    void pending.catch(() => undefined);
  });

  test("a chatty-runaway run (events forever) is still bounded by the wall-clock backstop", async () => {
    const cap = withCapHooks();
    const { cancel, handle } = fakeHandle(pendingForever());
    // A small backstop so the test terminates quickly; the inactivity window is
    // larger, so only the backstop can end this run.
    const backstopMs = 10 * 60 * 1000;
    const pending = runWithDurationCap({
      inactivityTimeoutMs: 60 * 60 * 1000, // never reached — events are constant
      maxRunDurationMs: backstopMs,
      monotonicClock: () => Date.now(),
      onCapReady: cap.onCapReady,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    // Emit every 30s across the whole backstop window: the watchdog is
    // perpetually reset, so the backstop is the only thing that can bite.
    const step = 30 * 1000;
    for (let elapsed = 0; elapsed < backstopMs; elapsed += step) {
      await vi.advanceTimersByTimeAsync(step);
      cap.emit();
    }
    const out = await pending;
    expect(out.status).toBe("failed");
    // Backstop expiry → the classifier's own duration-based `timeout-near-cap`
    // (no pre-stamped category on a backstop result).
    expect(out.failureCategory).toBeUndefined();
    expect(out.errorMessage).toContain("maxRunDurationMs");
    expect(out.durationMs).toBe(backstopMs);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("an absent inactivityTimeoutMs falls back to DEFAULT_INACTIVITY_TIMEOUT_MS", async () => {
    const cap = withCapHooks();
    const { cancel, handle } = fakeHandle(pendingForever());
    // No `inactivityTimeoutMs` (a legacy policy blob), backstop far above the
    // default window: the watchdog must still fire at the default, proving the
    // fallback is wired.
    const pending = runWithDurationCap({
      maxRunDurationMs: BIG_BACKSTOP_MS,
      monotonicClock: () => Date.now(),
      onCapReady: cap.onCapReady,
      onHandle: () => undefined,
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    cap.emit();
    await vi.advanceTimersByTimeAsync(DEFAULT_INACTIVITY_TIMEOUT_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.failureCategory).toBe("agent-collapse-on-running-tool");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("runWithDurationCap remote signals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("paused-clock suspend: discontinuity detector folds over-cap probe age and expires", async () => {
    const capHooks: { current?: DurationCapHandle } = {};
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => 0,
      wallClock: () => 0,
      onCapReady: (h) => {
        capHooks.current = h;
      },
      onHandle: () => undefined,
      signals: {
        getLiveness: () => ({ createdAtMs: 0, lastEventAtMs: CAP_MS + 1 }),
        probeRun: () =>
          Promise.resolve({
            createdAtMs: 0,
            status: "RUNNING",
            updatedAtMs: CAP_MS + 1,
          }),
      },
      start: () => Promise.resolve(handle),
    });
    await Promise.resolve();
    capHooks.current?.onDiscontinuitySample(100_000, 1_000);
    await Promise.resolve();
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBeGreaterThanOrEqual(CAP_MS);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("divergent-clock early fire with over-cap stream liveness expires on probe", async () => {
    let mono = 0;
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => mono,
      onHandle: () => undefined,
      signals: {
        getLiveness: () => ({ createdAtMs: 0, lastEventAtMs: CAP_MS + 1 }),
        probeRun: () =>
          Promise.resolve({
            createdAtMs: 0,
            updatedAtMs: CAP_MS + 1,
          }),
      },
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(CAP_MS);
    await vi.advanceTimersByTimeAsync(0);
    mono = 1;
    await vi.advanceTimersByTimeAsync(0);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("attach with broken seed uses grace window not a full cap", async () => {
    const onHandle = vi.fn();
    let resolveStart!: (h: AgentRunHandle) => void;
    const start = new Promise<AgentRunHandle>((resolve) => {
      resolveStart = resolve;
    });
    const pending = runWithDurationCap({
      kind: "attach",
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => Date.now(),
      onHandle,
      probeAgentId: "agent-x",
      probeRunId: "run-x",
      signals: { probeRun: () => Promise.resolve(undefined) },
      start: () => start,
    });
    const rejection = expect(pending).rejects.toBeInstanceOf(CursorRunStartTimedOutError);
    await vi.advanceTimersByTimeAsync(MIN_RESUMED_CAP_WINDOW_MS);
    await rejection;
    expect(onHandle).not.toHaveBeenCalled();
    const { handle } = fakeHandle(pendingForever());
    resolveStart(handle);
    await vi.advanceTimersByTimeAsync(0);
  });

  test("attach: over-cap probe evidence shrinks to the grace, and a real result inside it wins", async () => {
    const { handle } = fakeHandle(Promise.resolve(succeededResult));
    const pending = runWithDurationCap({
      elapsedMs: CAP_MS + 990,
      kind: "attach",
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => Date.now(),
      onHandle: () => undefined,
      probeAgentId: "agent-x",
      probeRunId: "run-x",
      signals: {
        probeRun: () =>
          Promise.resolve({
            createdAtMs: 0,
            status: "RUNNING",
            updatedAtMs: CAP_MS + 990,
          }),
      },
      start: () => Promise.resolve(handle),
    });
    // The probe folds an over-cap age immediately; the already-terminal
    // run's real result must still win inside the grace window.
    await vi.advanceTimersByTimeAsync(0);
    const out = await pending;
    expect(out.status).toBe("succeeded");
  });

  test("attach: over-cap probe evidence with no result expires at the grace boundary", async () => {
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      elapsedMs: CAP_MS + 990,
      kind: "attach",
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => Date.now(),
      onHandle: () => undefined,
      probeAgentId: "agent-x",
      probeRunId: "run-x",
      signals: {
        probeRun: () =>
          Promise.resolve({
            createdAtMs: 0,
            status: "RUNNING",
            updatedAtMs: CAP_MS + 990,
          }),
      },
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MIN_RESUMED_CAP_WINDOW_MS);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBeGreaterThanOrEqual(CAP_MS);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("rule 5 fail-closed: three unreachable probes with wall age over cap expires", async () => {
    const capHooks: { current?: DurationCapHandle } = {};
    const { cancel, handle } = fakeHandle(pendingForever());
    let mono = 0;
    let wall = 0;
    const pending = runWithDurationCap({
      elapsedMs: CAP_MS + 1000,
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => mono,
      onCapReady: (h) => {
        capHooks.current = h;
      },
      onHandle: () => undefined,
      signals: { probeRun: () => Promise.reject(new Error("api down")) },
      start: () => Promise.resolve(handle),
      wallClock: () => wall,
    });
    await vi.advanceTimersByTimeAsync(0);
    // Each discontinuity hit fires one probe; each rejection increments the
    // shared unreachable counter. The third failure with wallAge >= cap
    // fails closed.
    for (const [wallMs, monoMs] of [
      [100_000, 1],
      [200_000, 2],
      [300_000, 3],
    ] as const) {
      wall = wallMs;
      mono = monoMs;
      capHooks.current?.onDiscontinuitySample(wallMs, monoMs);
      await vi.advanceTimersByTimeAsync(0);
    }
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(out.durationMs).toBeGreaterThanOrEqual(CAP_MS);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("late fire without a probe charges the suspect segment as served and expires", async () => {
    let mono = 0;
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => mono,
      onHandle: () => undefined,
      signals: { getLiveness: () => undefined },
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    // Forward monotonic step: the timer fire is late by more than the
    // classifier slack, and with no probe to adjudicate, the armed delay is
    // charged as served — reaching the cap immediately.
    mono = CAP_MS + 61_000;
    await vi.advanceTimersByTimeAsync(CAP_MS);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("early fires without a probe still spend the rearm backstop", async () => {
    // Monotonic clock frozen at zero: every fire is early, nothing folds,
    // and only the rearm budget bounds the loop.
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => 0,
      onHandle: () => undefined,
      signals: { getLiveness: () => undefined },
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i <= MAX_CAP_REARMS; i += 1) {
      await vi.advanceTimersByTimeAsync(CAP_MS);
    }
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("a discontinuity sample below the threshold is ignored", async () => {
    const capHooks: { current?: DurationCapHandle } = {};
    const { handle } = fakeHandle(Promise.resolve(succeededResult));
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => Date.now(),
      onCapReady: (h) => {
        capHooks.current = h;
      },
      onHandle: () => undefined,
      signals: { probeRun: () => Promise.reject(new Error("must not be called")) },
      start: () => Promise.resolve(handle),
    });
    capHooks.current?.onDiscontinuitySample(1_000, 900);
    await vi.advanceTimersByTimeAsync(0);
    const out = await pending;
    expect(out.status).toBe("succeeded");
  });

  test("stream event fold alone can expire an over-cap remote run", async () => {
    let capHooks: DurationCapHandle | undefined;
    const { cancel, handle } = fakeHandle(pendingForever());
    const pending = runWithDurationCap({
      maxRunDurationMs: CAP_MS,
      monotonicClock: () => Date.now(),
      onCapReady: (h) => {
        capHooks = h;
      },
      onHandle: () => undefined,
      serverCreatedAtMs: 0,
      signals: { getLiveness: () => ({ createdAtMs: 0, lastEventAtMs: CAP_MS }) },
      start: () => Promise.resolve(handle),
    });
    await vi.advanceTimersByTimeAsync(0);
    capHooks?.onProviderStreamEvent(CAP_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    const out = await pending;
    expect(out.status).toBe("failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

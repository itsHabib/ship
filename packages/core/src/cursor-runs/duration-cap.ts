/**
 * Enforcement of `policy.maxRunDurationMs` over a cursor run. The runner
 * contract has no deadline of its own — a hung cloud agent can hold
 * `handle.result` open forever, and a stalled SDK start/attach call
 * (`Agent.create` / `agent.send` / `Agent.resume`) can hang before a handle
 * even exists — so `core` runs the whole start → terminal sequence under a
 * single cap window.
 *
 * Expiry with a live handle resolves a synthetic `failed` terminal carrying
 * `durationMs >= maxRunDurationMs` and no classification events, so
 * `classifyFailure` lands on `timeout-near-cap` deterministically. Expiry
 * before the handle exists rejects with `CursorRunStartTimedOutError`
 * instead — the SDK start call is what hung, not the agent run — which the
 * finalize path classifies `sdk-throw`.
 *
 * The cap is measured with a monotonic clock, and the timer re-validates real
 * elapsed on fire: a host suspend / wall-clock jump can fire the event-loop
 * timer before `windowMs` of real time actually passed, so a misfire re-arms
 * for the remaining window instead of synthesizing a false `timeout-near-cap`.
 * A re-arm-count backstop bounds this against a pathological clock.
 */

import type { AgentRunHandle, AgentRunResult } from "@ship/cursor-runner";
import type { Logger } from "@ship/logger";

import { CursorRunStartTimedOutError } from "../errors.js";

/**
 * Floor for the cap window when a run is resumed with most (or all) of its
 * budget already spent — an attach always gets a short grace window so a
 * run that is already terminal SDK-side can still deliver its real result.
 * Clamped to `maxRunDurationMs` itself, so the grace never grants a window
 * larger than the configured cap.
 */
export const MIN_RESUMED_CAP_WINDOW_MS = 60_000;

/**
 * Node clamps a `setTimeout` delay above the 32-bit signed max to 1ms, which
 * would misfire a multi-week cap instantly. We clamp each physical wait to this
 * ceiling instead: a cap beyond ~24.9 days is served as a sequence of clamped
 * segments, re-arming for the next segment until the full window elapses. That
 * healthy segmentation is distinct from a suspend misfire — it neither warns
 * nor counts against `MAX_CAP_REARMS`. The synthetic terminal still reports the
 * configured cap as the duration; the clamp only bounds each physical wait.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Absolute backstop on *misfire* re-arming. Each genuine misfire (a suspend /
 * clock jump firing the timer before its armed delay elapsed in real time)
 * re-arms once and counts against this budget; a healthy clock produces no
 * misfires. (A clamped segment of a cap beyond `MAX_TIMER_DELAY_MS` also
 * re-arms, but on a healthy clock — it is not a misfire and does not count
 * here.) This bounds re-arming against a pathological / frozen monotonic clock
 * that would otherwise never reach the window: once the count is exceeded, the
 * cap fires regardless. Sized far above any realistic suspend count.
 */
export const MAX_CAP_REARMS = 64;

/** Monotonic wall time (immune to system-clock jumps) for the cap measurement. */
const defaultMonotonicClock = (): number => performance.now();

export interface DurationCapRunArgs {
  /** Starts the run (fresh dispatch) or attach (resume); invoked once, immediately. */
  readonly start: () => Promise<AgentRunHandle>;
  /**
   * Registration hook (store rows, event pump, active-runs entry); invoked
   * once iff the handle arrives before the cap expires. A handle arriving
   * after expiry is cancelled and never registered, so no bookkeeping
   * outlives the already-finalized run.
   */
  readonly onHandle: (handle: AgentRunHandle) => void;
  /** `policy.maxRunDurationMs` for this run. */
  readonly maxRunDurationMs: number;
  /**
   * Wall time the run consumed before this await began. Zero for fresh
   * dispatches; positive on resume, so a restart doesn't re-grant the
   * full cap to a run that already spent most of it.
   */
  readonly elapsedMs?: number;
  /**
   * Monotonic clock for the cap measurement; defaults to `performance.now`.
   * Injectable so tests can drive elapsed independently of `setTimeout` firing.
   * Must be monotonic (immune to wall-clock jumps) — that is what lets a timer
   * misfire after a suspend / clock jump re-arm instead of falsely expiring.
   */
  readonly monotonicClock?: () => number;
  readonly log?: Logger;
}

/**
 * Resolves with the runner's terminal result, or — once the remaining cap
 * window of real (monotonic) time expires — cancels the run (best-effort, not
 * awaited) and resolves with a synthetic `failed` terminal instead. Rejects
 * when `start` rejects, when the registration hook throws, or when the window
 * expires before `start` produced a handle (`CursorRunStartTimedOutError`).
 *
 * The timer re-validates against the monotonic clock on fire: a suspend /
 * wall-clock jump that fires it before `windowMs` of real time elapsed re-arms
 * for the remaining window rather than giving up (bounded by `MAX_CAP_REARMS`).
 */
export async function runWithDurationCap(args: DurationCapRunArgs): Promise<AgentRunResult> {
  const elapsedMs = args.elapsedMs ?? 0;
  const windowMs = capWindowMs(args.maxRunDurationMs, elapsedMs);
  const monotonicNow = args.monotonicClock ?? defaultMonotonicClock;
  const startedMono = monotonicNow();
  let handle: AgentRunHandle | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rearms = 0;
  // Monotonic time the current timer was armed, and the delay it was armed for.
  // Comparing real elapsed-since-arm against the armed delay separates a healthy
  // clamped-segment continuation (full delay elapsed) from a suspend misfire
  // (fired early because the monotonic clock barely advanced).
  let armedAtMono = 0;
  let armedDelayMs = 0;

  // Everything that arms the timer or calls `start()` lives inside the try,
  // so a synchronous throw from an injected runner still hits the finally
  // and clears the cap timer rather than leaking it.
  try {
    const capExpiry = new Promise<AgentRunResult>((resolve, reject) => {
      const onCapTimer = (): void => {
        const nowMono = monotonicNow();
        const realElapsed = nowMono - startedMono;
        const windowRemainingMs = windowMs - realElapsed;

        // The full armed delay elapsed in real (monotonic) time but the window
        // hasn't: a clamped segment of a cap beyond MAX_TIMER_DELAY_MS finishing
        // on a healthy clock. Continue with the next segment — not a misfire, so
        // it neither warns nor spends the misfire backstop.
        if (windowRemainingMs > 0 && nowMono - armedAtMono >= armedDelayMs) {
          armedAtMono = nowMono;
          armedDelayMs = Math.min(windowRemainingMs, MAX_TIMER_DELAY_MS);
          timer = setTimeout(onCapTimer, armedDelayMs);
          return;
        }

        // Fired before its armed delay elapsed in real time — a host suspend /
        // wall-clock jump. Re-arm for the remaining window, bounded by the
        // backstop against a frozen clock that never advances to the window.
        if (windowRemainingMs > 0 && rearms < MAX_CAP_REARMS) {
          rearms += 1;
          armedAtMono = nowMono;
          armedDelayMs = Math.min(windowRemainingMs, MAX_TIMER_DELAY_MS);
          args.log?.warn(
            { realElapsed, rearms, windowMs, windowRemainingMs },
            "cap timer fired before real elapsed reached the window (host suspend / clock jump); re-arming",
          );
          timer = setTimeout(onCapTimer, armedDelayMs);
          return;
        }

        expired = true;
        args.log?.warn(
          {
            elapsedMs,
            maxRunDurationMs: args.maxRunDurationMs,
            realElapsed,
            rearms,
            startResolved: handle !== undefined,
            windowMs,
          },
          "policy.maxRunDurationMs exceeded; cancelling run",
        );
        if (handle === undefined) {
          reject(new CursorRunStartTimedOutError(windowMs));
          return;
        }
        // Resolve the synthetic terminal BEFORE firing cancel: a runner whose
        // cancel settles `result` synchronously (as "cancelled") must not win
        // the race — the cap verdict is `failed`, not `cancelled`.
        resolve(capExceededResult(elapsedMs + windowMs));
        cancelBestEffort(handle);
      };
      armedAtMono = monotonicNow();
      armedDelayMs = Math.min(windowMs, MAX_TIMER_DELAY_MS);
      timer = setTimeout(onCapTimer, armedDelayMs);
    });
    // The loser of the race can still settle later — e.g. the cap rejects
    // pre-handle and `start()` (a hung `Agent.create`/`Agent.resume`) rejects
    // minutes afterward, or the cap resolves synthetic and the live
    // `handle.result` rejects post-cancel. `Promise.race` retains a reaction
    // on each input, so a late rejection is already observed, but these
    // sibling swallowers make that guarantee explicit and independent of the
    // host's race implementation. They never suppress the winner: the race
    // keeps its own reaction and still propagates the winning settlement.
    void capExpiry.catch(() => {
      /* swallow late loser rejection */
    });

    const terminal = args.start().then((h) => {
      // Past expiry the race has already settled; the late handle is only
      // cancelled, never registered. The returned value is discarded.
      if (expired) {
        cancelBestEffort(h);
        return capExceededResult(elapsedMs + windowMs);
      }
      handle = h;
      args.onHandle(h);
      return h.result;
    });
    void terminal.catch(() => {
      /* swallow late loser rejection */
    });

    return await Promise.race([terminal, capExpiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function capWindowMs(maxRunDurationMs: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return maxRunDurationMs;
  const graceMs = Math.min(MIN_RESUMED_CAP_WINDOW_MS, maxRunDurationMs);
  return Math.max(maxRunDurationMs - elapsedMs, graceMs);
}

// Best-effort: the cap verdict stands whether or not the SDK-side cancel
// lands (a hung agent may not acknowledge it).
function cancelBestEffort(handle: AgentRunHandle): void {
  handle.cancel().catch(() => {
    /* swallow */
  });
}

function capExceededResult(durationMs: number): AgentRunResult {
  return {
    branches: [],
    durationMs,
    errorMessage:
      "run exceeded policy.maxRunDurationMs; ship requested an SDK-run cancel (best-effort)",
    status: "failed",
  };
}

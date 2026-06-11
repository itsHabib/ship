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
 */

import type { CursorRunHandle, CursorRunResult } from "@ship/cursor-runner";
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
 * Node clamps a `setTimeout` delay above the 32-bit signed max to 1ms,
 * which would misfire a multi-week cap instantly. We clamp the timer delay
 * here instead: a cap beyond ~24.9 days fires at the limit rather than at
 * 1ms. The synthetic terminal still reports the configured cap as the
 * duration — the clamp only bounds the physical wait.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface DurationCapRunArgs {
  /** Starts the run (fresh dispatch) or attach (resume); invoked once, immediately. */
  readonly start: () => Promise<CursorRunHandle>;
  /**
   * Registration hook (store rows, event pump, active-runs entry); invoked
   * once iff the handle arrives before the cap expires. A handle arriving
   * after expiry is cancelled and never registered, so no bookkeeping
   * outlives the already-finalized run.
   */
  readonly onHandle: (handle: CursorRunHandle) => void;
  /** `policy.maxRunDurationMs` for this run. */
  readonly maxRunDurationMs: number;
  /**
   * Wall time the run consumed before this await began. Zero for fresh
   * dispatches; positive on resume, so a restart doesn't re-grant the
   * full cap to a run that already spent most of it.
   */
  readonly elapsedMs?: number;
  readonly log?: Logger;
}

/**
 * Resolves with the runner's terminal result, or — once the remaining cap
 * window expires — cancels the run (best-effort, not awaited) and resolves
 * with a synthetic `failed` terminal instead. Rejects when `start` rejects,
 * when the registration hook throws, or when the window expires before
 * `start` produced a handle (`CursorRunStartTimedOutError`).
 */
export async function runWithDurationCap(args: DurationCapRunArgs): Promise<CursorRunResult> {
  const elapsedMs = args.elapsedMs ?? 0;
  const windowMs = capWindowMs(args.maxRunDurationMs, elapsedMs);
  let handle: CursorRunHandle | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Everything that arms the timer or calls `start()` lives inside the try,
  // so a synchronous throw from an injected runner still hits the finally
  // and clears the cap timer rather than leaking it.
  try {
    const capExpiry = new Promise<CursorRunResult>((resolve, reject) => {
      timer = setTimeout(
        () => {
          expired = true;
          args.log?.warn(
            {
              elapsedMs,
              maxRunDurationMs: args.maxRunDurationMs,
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
        },
        Math.min(windowMs, MAX_TIMER_DELAY_MS),
      );
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
function cancelBestEffort(handle: CursorRunHandle): void {
  handle.cancel().catch(() => {
    /* swallow */
  });
}

function capExceededResult(durationMs: number): CursorRunResult {
  return {
    branches: [],
    durationMs,
    errorMessage:
      "run exceeded policy.maxRunDurationMs; ship requested an SDK-run cancel (best-effort)",
    status: "failed",
  };
}

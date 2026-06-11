/**
 * Enforcement of `policy.maxRunDurationMs` over an in-flight cursor run.
 * The runner contract has no deadline of its own — a hung cloud agent can
 * hold `handle.result` open forever — so `core` races the terminal promise
 * against the policy cap and synthesizes a `failed` terminal when the cap
 * wins. The synthetic result carries `durationMs >= maxRunDurationMs` and
 * no classification events, so `classifyFailure` lands on
 * `timeout-near-cap` deterministically.
 */

import type { CursorRunResult } from "@ship/cursor-runner";
import type { Logger } from "@ship/logger";

/**
 * Floor for the cap window when a run is resumed with most (or all) of its
 * budget already spent — an attach always gets a short grace window so a
 * run that is already terminal SDK-side can still deliver its real result.
 */
export const MIN_RESUMED_CAP_WINDOW_MS = 60_000;

export interface DurationCapArgs {
  /** The runner handle's terminal promise. */
  readonly result: Promise<CursorRunResult>;
  /** The runner handle's idempotent cancel; fired best-effort at cap expiry. */
  readonly cancel: () => Promise<void>;
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
 * with a synthetic `failed` terminal instead. Never rejects on its own;
 * runner rejections propagate unchanged.
 */
export async function awaitResultWithDurationCap(args: DurationCapArgs): Promise<CursorRunResult> {
  const elapsedMs = args.elapsedMs ?? 0;
  const windowMs = capWindowMs(args.maxRunDurationMs, elapsedMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capExpiry = new Promise<CursorRunResult>((resolve) => {
    timer = setTimeout(() => {
      args.log?.warn(
        { elapsedMs, maxRunDurationMs: args.maxRunDurationMs, windowMs },
        "policy.maxRunDurationMs exceeded; cancelling run",
      );
      // Resolve the synthetic terminal BEFORE firing cancel: a runner whose
      // cancel settles `result` synchronously (as "cancelled") must not win
      // the race — the cap verdict is `failed`, not `cancelled`.
      resolve(capExceededResult(elapsedMs + windowMs));
      // Best-effort: the synthetic terminal stands whether or not the
      // SDK-side cancel lands (a hung agent may not acknowledge it).
      args.cancel().catch(() => {
        /* swallow */
      });
    }, windowMs);
  });
  try {
    return await Promise.race([args.result, capExpiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function capWindowMs(maxRunDurationMs: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return maxRunDurationMs;
  return Math.max(maxRunDurationMs - elapsedMs, MIN_RESUMED_CAP_WINDOW_MS);
}

function capExceededResult(durationMs: number): CursorRunResult {
  return {
    branches: [],
    durationMs,
    errorMessage: "run exceeded policy.maxRunDurationMs; ship cancelled the SDK run",
    status: "failed",
  };
}

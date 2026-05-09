/**
 * Deterministic test clock — `() => string` that auto-advances on every call,
 * with explicit `.advance(ms)` and `.set(iso)` controls.
 *
 * Why a clock helper at all: every package in the V1 stack reads "now" through
 * an injected `() => string`. Without a deterministic substitute, scenario
 * tests get racy `created_at` values, ULIDs that don't sort in call order, and
 * `updated_at` bumps that look correct in CI and wrong locally. `createTestClock`
 * gives every test a predictable wall clock without monkey-patching `Date`.
 *
 * Auto-advance: each call moves the clock forward by `stepMs` (default 1ms)
 * before returning the new ISO string. That way two consecutive
 * `clock()` calls produce strictly-different timestamps — important for
 * `listRuns` ordering tests where `created_at` is the primary sort key.
 *
 * Explicit control: `.set("2026-05-09T...")` jumps to a specific moment;
 * `.advance(60_000)` jumps a relative amount. Both useful for "what does the
 * world look like 30 minutes after start" scenario shapes.
 */

/**
 * A callable wall-clock substitute. Returns ISO-8601 with offset (`Z`) on
 * every invocation, advancing by the configured step.
 *
 * Methods:
 * - `advance(ms)` — move the clock forward by `ms` milliseconds without
 *                   producing an ISO string. Subsequent calls reflect the
 *                   new position (after the next auto-step).
 * - `set(iso)`    — jump to the given absolute moment. The next call
 *                   returns that moment + step.
 *
 * Example:
 * ```ts
 * const clock = createTestClock("2026-05-09T00:00:00.000Z");
 * clock(); // "2026-05-09T00:00:00.001Z"
 * clock(); // "2026-05-09T00:00:00.002Z"
 * clock.advance(60_000);
 * clock(); // "2026-05-09T00:01:00.003Z"
 * clock.set("2027-01-01T00:00:00.000Z");
 * clock(); // "2027-01-01T00:00:00.001Z"
 * ```
 */
export interface TestClock {
  (): string;
  advance: (ms: number) => void;
  set: (iso: string) => void;
}

/** Default step between consecutive `clock()` calls when none is specified. */
const DEFAULT_STEP_MS = 1;

/**
 * Constructs a `TestClock` rooted at `start`. Each call advances by `stepMs`
 * before returning, so consecutive calls always produce strictly-different
 * timestamps in the order they were made.
 *
 * @param start  ISO-8601-with-offset starting point. Throws `RangeError` if
 *               `Date` rejects it (so a typo'd fixture fails loud at clock
 *               construction, not at first use).
 * @param stepMs Auto-advance per call, default 1ms. Set higher in scenarios
 *               that span "minutes apart" without manual `.advance` between
 *               every call.
 */
export function createTestClock(start: string, stepMs: number = DEFAULT_STEP_MS): TestClock {
  if (!Number.isFinite(stepMs) || stepMs < 0) {
    throw new RangeError(
      `createTestClock: stepMs must be a non-negative finite number, got ${String(stepMs)}`,
    );
  }
  let cursor = parseStart(start);

  const clock = ((): string => {
    cursor += stepMs;
    return new Date(cursor).toISOString();
  }) as TestClock;

  clock.advance = (ms: number): void => {
    if (!Number.isFinite(ms)) {
      throw new RangeError(`TestClock.advance: ms must be finite, got ${String(ms)}`);
    }
    cursor += ms;
  };

  clock.set = (iso: string): void => {
    cursor = parseStart(iso);
  };

  return clock;
}

/**
 * Parses an ISO string into a numeric ms epoch, throwing `RangeError` on
 * `Invalid Date` so a malformed fixture fails at clock construction rather
 * than silently producing `"NaN-NaN-..."` strings later.
 */
function parseStart(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`createTestClock: invalid ISO timestamp ${iso}`);
  }
  return ms;
}

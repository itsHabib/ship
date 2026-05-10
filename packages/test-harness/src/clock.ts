/**
 * Deterministic test clock — `() => string` that auto-advances on every call,
 * with explicit `.advance(ms)` and `.set(iso)` controls. Lets scenario tests
 * inject "now" without monkey-patching `Date`.
 */

/**
 * A callable wall-clock substitute. Returns ISO-8601 with offset on every
 * invocation, advancing by the configured step. `.advance(ms)` jumps without
 * emitting; `.set(iso)` jumps absolute.
 */
export interface TestClock {
  (): string;
  advance: (ms: number) => void;
  set: (iso: string) => void;
}

const DEFAULT_STEP_MS = 1;

/**
 * Constructs a `TestClock` rooted at `start`. Each call advances by `stepMs`
 * before returning, so consecutive calls produce strictly-different
 * timestamps in call order. Throws `RangeError` on invalid `start` or
 * non-finite / negative `stepMs`.
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

/** Parses `iso` to ms epoch, throwing `RangeError` on `Invalid Date`. */
function parseStart(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`createTestClock: invalid ISO timestamp ${iso}`);
  }
  return ms;
}

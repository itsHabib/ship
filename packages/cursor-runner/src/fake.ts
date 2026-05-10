/**
 * `FakeCursorRunner` — scriptable stand-in for `LocalCursorRunner`,
 * exported under `@ship/cursor-runner/test/fake`. Downstream tests
 * (Phase 6 `core`, harness scenarios) drive it deterministically with
 * no API key and no network.
 *
 * Behavioral parity with `LocalCursorRunner`: `onEvent` swallow (sync +
 * async), idempotent cancel across `signal` and `handle.cancel()`,
 * timer/listener cleanup on natural termination. See
 * `phases/05-cursor-runner.md` for the contract.
 */

import type { SDKMessage } from "@cursor/sdk";

import type { CursorRunHandle, CursorRunInput, CursorRunner, CursorRunResult } from "./runner.js";

/** A single scripted run. The fake pops one of these per `run()` call. */
export interface FakeCursorScript {
  /** Emitted in order through `onEvent`. */
  readonly events: readonly SDKMessage[];
  /** What `handle.result` resolves to once emission finishes naturally. */
  readonly result: CursorRunResult;
  /**
   * What `handle.cancel()` does mid-flight:
   * - `"complete"` (default): stop emission, resolve as `cancelled`.
   * - `"ignore"`: cancel is a no-op; script runs to completion.
   * - `"throw"`: only the first pre-terminal cancel rejects; subsequent calls no-op.
   * Signal-abort always hard-cancels regardless of this field.
   */
  readonly cancelBehavior?: "complete" | "ignore" | "throw";
  /** `0` (default) → events fire in tight microtasks. `> 0` → real-time delay between events. */
  readonly delayMsBetweenEvents?: number;
}

/** Recorded `run()` call metadata for post-hoc test assertions. */
export interface FakeCursorRunCall {
  readonly input: CursorRunInput;
  readonly script: FakeCursorScript;
}

const CANCEL_THROWN_MESSAGE = "FakeCursorRunner: scripted cancel error";

export interface FakeCursorRunnerOptions {
  /** Used when `enqueue()` hasn't been called for a `run()` invocation. */
  readonly defaultScript?: FakeCursorScript;
}

/**
 * Fake implementation of `CursorRunner`. Construct once, `enqueue()`
 * per expected `run()` call. Without a `defaultScript`, an un-enqueued
 * `run()` throws — loud-failure for misconfigured tests.
 */
export class FakeCursorRunner implements CursorRunner {
  readonly #scripts: FakeCursorScript[] = [];
  readonly #calls: FakeCursorRunCall[] = [];
  readonly #defaultScript: FakeCursorScript | undefined;
  #runCounter = 0;

  constructor(opts: FakeCursorRunnerOptions = {}) {
    this.#defaultScript = opts.defaultScript;
  }

  /** Append a script to the FIFO queue. */
  enqueue(script: FakeCursorScript): void {
    this.#scripts.push(script);
  }

  /** All `run()` calls in invocation order. */
  get calls(): readonly FakeCursorRunCall[] {
    return this.#calls;
  }

  /** Number of scripts still queued (excludes `defaultScript`). */
  get pendingScriptCount(): number {
    return this.#scripts.length;
  }

  async run(input: CursorRunInput): Promise<CursorRunHandle> {
    const script = this.#scripts.shift() ?? this.#defaultScript;
    if (script === undefined) {
      throw new Error(
        "FakeCursorRunner: run() called with no script enqueued and no defaultScript provided",
      );
    }
    this.#calls.push({ input, script });

    this.#runCounter += 1;
    const callIndex = this.#runCounter;
    const agentId = `agent-fake-${callIndex.toString().padStart(4, "0")}`;
    const runId = `run-fake-${callIndex.toString().padStart(4, "0")}`;

    let terminated = false;
    let cancelAttempted = false;
    let resolveResult!: (value: CursorRunResult) => void;
    const result = new Promise<CursorRunResult>((resolve) => {
      resolveResult = resolve;
    });

    // Resources released on termination so detached state (pending
    // timers, signal listeners) doesn't outlive the run.
    let activeSleep: { cancel: () => void } | null = null;
    let signalListener: (() => void) | null = null;

    const finalize = (terminal: CursorRunResult): void => {
      if (terminated) return;
      terminated = true;
      activeSleep?.cancel();
      activeSleep = null;
      if (signalListener !== null && input.signal !== undefined) {
        input.signal.removeEventListener("abort", signalListener);
      }
      signalListener = null;
      resolveResult(terminal);
    };

    /** `handle.cancel()` path — respects script's `cancelBehavior`. Idempotent. */
    const cancelInternal = (): Promise<void> => {
      const behavior = script.cancelBehavior ?? "complete";
      if (cancelAttempted) {
        return Promise.resolve();
      }
      cancelAttempted = true;
      if (behavior === "throw" && !terminated) {
        return Promise.reject(new Error(CANCEL_THROWN_MESSAGE));
      }
      if (behavior === "ignore") {
        return Promise.resolve();
      }
      finalize({ ...script.result, status: "cancelled" });
      return Promise.resolve();
    };

    /** Signal-abort path — always hard-cancels, ignoring `cancelBehavior`. */
    const hardCancelFromSignal = (): void => {
      if (terminated) return;
      cancelAttempted = true;
      finalize({ ...script.result, status: "cancelled" });
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        // Pre-aborted signal must be handled before #emit starts —
        // otherwise default delay=0 lets emission run synchronously to
        // completion before the signal is observed.
        hardCancelFromSignal();
      } else {
        signalListener = hardCancelFromSignal;
        input.signal.addEventListener("abort", signalListener, { once: true });
      }
    }

    const setActiveSleep = (s: { cancel: () => void } | null): void => {
      activeSleep = s;
    };
    void this.#emit(script, input, () => terminated, finalize, setActiveSleep);

    return Promise.resolve({ agentId, runId, result, cancel: cancelInternal });
  }

  async #emit(
    script: FakeCursorScript,
    input: CursorRunInput,
    isTerminated: () => boolean,
    finalize: (terminal: CursorRunResult) => void,
    setActiveSleep: (s: { cancel: () => void } | null) => void,
  ): Promise<void> {
    const delay = script.delayMsBetweenEvents ?? 0;
    for (const ev of script.events) {
      if (delay > 0) {
        const s = abortableSleep(delay);
        setActiveSleep(s);
        await s.promise;
        setActiveSleep(null);
      }
      if (isTerminated()) return;
      // Swallow both sync throws and async rejections — onEvent is
      // fire-and-forget per ED-4. The signature accepts `=> void |
      // Promise<void>` but we never await.
      try {
        const maybePromise: unknown = input.onEvent(ev);
        if (isPromiseLike(maybePromise)) {
          maybePromise.then(undefined, () => {
            /* swallow */
          });
        }
      } catch {
        /* swallow */
      }
    }
    if (!isTerminated()) {
      finalize(script.result);
    }
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Sleeps for `ms` ms; `cancel()` clears the timer and resolves immediately. */
function abortableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let cancelFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    cancelFn = (): void => {
      clearTimeout(t);
      resolve();
    };
  });
  return { cancel: cancelFn, promise };
}

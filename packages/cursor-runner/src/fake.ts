/**
 * `FakeCursorRunner` — scriptable stand-in for `LocalCursorRunner`,
 * exported under the `./test/fake` subpath of `@ship/cursor-runner`.
 *
 * Purpose: downstream tests (`@ship/core`'s ShipService unit tests, the
 * harness scenarios that land in Phase 6) need a `CursorRunner` they can
 * drive deterministically — no API key, no SDK calls, no network. The
 * fake takes a queue of `FakeCursorScript`s; each `run()` pops one off
 * the front and emits its events / resolves to its result.
 *
 * Why a class with `enqueue(script)` rather than a callback-driven
 * generator: scenario tests benefit from a single fake that the harness
 * sets up once and feeds scripts to as the scenario unfolds. The class
 * shape also mirrors `LocalCursorRunner`'s shape, so consumers can swap
 * between the two without touching their wiring code.
 *
 * Why the fake lives in this package: it's intimate with the real
 * implementation. A type change in `CursorRunInput` should fail the
 * fake's typecheck immediately, not after a separate package's CI runs.
 * The `./test/fake` subpath in `package.json#exports` keeps consumer
 * production code from importing it accidentally — the path is only
 * reachable as `@ship/cursor-runner/test/fake`, never via the main
 * barrel.
 *
 * Behavioral parity with the real runner:
 * - `onEvent` exceptions are caught and silently swallowed (matches
 *   ED-4; tests written against the fake will see the same swallow
 *   behavior production exhibits).
 * - Events emit synchronously by default (same-microtask sequencing
 *   between events) so per-event call ordering matches what
 *   `LocalCursorRunner`'s `for await` loop produces. Tests that need
 *   deliberate async pacing pass `delayMsBetweenEvents > 0`.
 * - `cancel()` is idempotent runner-side; a second call (or any call
 *   after natural termination) is a no-op regardless of
 *   `cancelBehavior`. Mirrors the runner-side `terminated` guard from
 *   `LocalCursorRunner`.
 *
 * What the fake does NOT do:
 * - Validate that `input.prompt` / `input.cwd` / `input.model` "make
 *   sense." It records what it was passed; tests assert on that
 *   directly via `runner.calls`. Validating inputs would couple the
 *   fake to the real runner's config-resolution logic, which is `core`'s
 *   concern, not the runner's.
 *
 * Cancellation paths honored: `input.signal` (the AbortSignal route
 * `core` will use for SIGINT / per-run timeout) AND `handle.cancel()`.
 * Both go through the same internal cancellation pipeline so cancel
 * idempotency holds across signal-then-handle, handle-then-signal,
 * and any combination thereof.
 */

import type { SDKMessage } from "@cursor/sdk";

import type { CursorRunHandle, CursorRunInput, CursorRunner, CursorRunResult } from "./runner.js";

/**
 * A single scripted run. The fake pops one of these per `run()` call.
 *
 * Fields:
 * - `events`               — emitted in order through `onEvent`. Empty
 *                            array is fine (a run with no streamed
 *                            events).
 * - `result`               — what `handle.result` resolves to once
 *                            emission finishes naturally. May be
 *                            overridden by cancel / signal paths
 *                            depending on `cancelBehavior`.
 * - `cancelBehavior`       — what `handle.cancel()` does to an
 *                            in-progress run:
 *                              - `"complete"` (default): stops emission
 *                                and resolves `result` with
 *                                `{ ...script.result, status:
 *                                "cancelled" }`. Idempotent.
 *                              - `"ignore"`: cancel is a no-op; the
 *                                script runs to completion regardless.
 *                                Useful for testing "consumer cancels
 *                                a run that already terminated."
 *                              - `"throw"`: `handle.cancel()` rejects
 *                                with a fixed error. Useful for
 *                                testing consumer error paths around
 *                                cancel.
 * - `delayMsBetweenEvents` — `0` (default) → events fire as fast as
 *                            the microtask scheduler will let them,
 *                            mirroring `LocalCursorRunner`'s per-
 *                            iteration `for await` shape. `> 0` →
 *                            real-time delay between events; useful
 *                            for tests that want to interleave a
 *                            cancel mid-stream.
 */
export interface FakeCursorScript {
  readonly events: readonly SDKMessage[];
  readonly result: CursorRunResult;
  readonly cancelBehavior?: "complete" | "ignore" | "throw";
  readonly delayMsBetweenEvents?: number;
}

/**
 * Recorded call metadata. The fake keeps one entry per `run()` call so
 * tests can assert on what the runner was driven with.
 *
 * Holding the input by reference (not a deep clone) is intentional —
 * tests that want to assert on identity (the `core` codepath built one
 * input and didn't reconstruct it) get that for free; tests that want
 * structural assertions still get them via vitest's deep matchers.
 */
export interface FakeCursorRunCall {
  readonly input: CursorRunInput;
  readonly script: FakeCursorScript;
}

const CANCEL_THROWN_MESSAGE = "FakeCursorRunner: scripted cancel error";

/**
 * Construction options. `defaultScript` is the fallback when `enqueue`
 * hasn't been called for a `run()` invocation. Without it, an
 * un-enqueued `run()` throws — the loud-failure mode that catches
 * misconfigured scenario tests.
 */
export interface FakeCursorRunnerOptions {
  readonly defaultScript?: FakeCursorScript;
}

/**
 * Fake implementation of `CursorRunner`.
 *
 * Construct once, enqueue per expected `run()` call. Reading order:
 *
 * 1. `enqueue(scriptA)` — queue head: `[scriptA]`
 * 2. `enqueue(scriptB)` — queue head: `[scriptA, scriptB]`
 * 3. `run(input1)`      — pops `scriptA`; queue head: `[scriptB]`
 * 4. `run(input2)`      — pops `scriptB`; queue empty
 * 5. `run(input3)`      — uses `defaultScript` if set, else throws
 *
 * `runner.calls` records every `run()` call in order for post-hoc
 * assertions.
 */
export class FakeCursorRunner implements CursorRunner {
  readonly #scripts: FakeCursorScript[] = [];
  readonly #calls: FakeCursorRunCall[] = [];
  readonly #defaultScript: FakeCursorScript | undefined;
  #runCounter = 0;

  constructor(opts: FakeCursorRunnerOptions = {}) {
    this.#defaultScript = opts.defaultScript;
  }

  /**
   * Append a script to the FIFO queue. The next `run()` call consumes
   * the script at the head of the queue.
   */
  enqueue(script: FakeCursorScript): void {
    this.#scripts.push(script);
  }

  /** All `run()` calls in invocation order. Read-only view for tests. */
  get calls(): readonly FakeCursorRunCall[] {
    return this.#calls;
  }

  /** Number of scripts still queued (excluding `defaultScript`). */
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

    const finalize = (terminal: CursorRunResult): void => {
      if (terminated) return;
      terminated = true;
      resolveResult(terminal);
    };

    // Both cancellation paths funnel through here so idempotency holds
    // across any combination of signal-abort and handle.cancel(). The
    // first call drives the script's `cancelBehavior`; every subsequent
    // call is a no-op (resolves), regardless of `cancelBehavior`.
    const cancelInternal = (): Promise<void> => {
      const behavior = script.cancelBehavior ?? "complete";
      if (cancelAttempted) {
        // Idempotent: a second cancel from any path is a silent no-op
        // even if the first call threw under `cancelBehavior: "throw"`.
        return Promise.resolve();
      }
      cancelAttempted = true;
      if (behavior === "throw" && !terminated) {
        // Cancel-after-terminal is always a no-op even under "throw" —
        // only the first pre-terminal cancel rejects.
        return Promise.reject(new Error(CANCEL_THROWN_MESSAGE));
      }
      if (behavior === "ignore") {
        return Promise.resolve();
      }
      // "complete": resolve with status: "cancelled", overriding the
      // script's terminal status. No-op if already terminated.
      finalize({ ...script.result, status: "cancelled" });
      return Promise.resolve();
    };

    // Wire input.signal — `core` will pass an AbortSignal for SIGINT
    // and per-run timeouts. The fake honors it the same way the real
    // runner will (forwards to the same internal pipeline). A
    // pre-aborted signal MUST be processed before #emit starts —
    // otherwise with the default `delayMsBetweenEvents: 0`, #emit
    // runs synchronously to completion and resolves the result before
    // the signal check ever fires (real bug caught in cycle-2 review).
    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        void cancelInternal().catch(() => {
          // If cancelBehavior is "throw" and the signal was already
          // aborted, the resulting rejection is the consumer's problem
          // to surface — the fake doesn't have a back-channel for it.
          // Production code wouldn't pass an already-aborted signal
          // and expect a clean exit.
        });
      } else {
        const onAbort = (): void => {
          void cancelInternal().catch(() => {
            // Same rationale as above for the pre-aborted branch.
          });
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Start emission AFTER the pre-abort check. If the signal was
    // pre-aborted, `terminated` is now true and `#emit` exits its
    // loop on the first iteration. Otherwise emission proceeds as
    // normal and `signal.abort()` interleaves via the listener above.
    void this.#emit(script, input, () => terminated, finalize);

    return Promise.resolve({ agentId, runId, result, cancel: cancelInternal });
  }

  async #emit(
    script: FakeCursorScript,
    input: CursorRunInput,
    isTerminated: () => boolean,
    finalize: (terminal: CursorRunResult) => void,
  ): Promise<void> {
    const delay = script.delayMsBetweenEvents ?? 0;
    for (const ev of script.events) {
      if (delay > 0) await sleep(delay);
      // Re-check terminated AFTER the delay: cancel can interleave during
      // the sleep window via either `handle.cancel()` or `signal.abort()`.
      // The only way `terminated` becomes true mid-loop is during this
      // sleep, so a single post-sleep check is sufficient — we don't need
      // a pre-sleep check too.
      if (isTerminated()) return;
      try {
        input.onEvent(ev);
      } catch {
        // Mirror ED-4: onEvent exceptions are swallowed at the runner
        // boundary; the run is unaffected.
      }
    }
    if (!isTerminated()) {
      finalize(script.result);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

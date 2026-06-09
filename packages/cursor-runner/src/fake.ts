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
import type { ArtifactRef } from "@ship/workflow";

import type {
  CursorRunAttachInput,
  CursorRunHandle,
  CursorRunInput,
  CursorRunner,
  CursorRunResult,
} from "./runner.js";

import { attachInputAsRunInput, MAX_CLASSIFICATION_EVENTS } from "./_shared.js";
import { captureListedArtifacts } from "./artifacts-capture.js";
import { CursorAgentNotFoundError } from "./errors.js";

/** A single scripted run. The fake pops one of these per `run()` call. */
export interface FakeCursorScript {
  /** Emitted in order through `onEvent`. */
  readonly events: readonly SDKMessage[];
  /** What `handle.result` resolves to once emission finishes naturally. */
  readonly result: CursorRunResult;
  /**
   * When set, invoked at terminal (cloud `listArtifacts` parity) with the
   * same timeout as `CloudCursorRunner`. Overrides `result.artifacts`.
   */
  readonly listArtifacts?: () => Promise<readonly ArtifactRef[] | undefined>;
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
  /** Bytes returned by `downloadArtifact` for paths in `result.artifacts`. */
  readonly artifactBytes?: Readonly<Record<string, Buffer>>;
}

/** Scripted attach outcome — either a resumable run or a not-found rejection. */
export type FakeCursorAttachScript =
  | FakeCursorScript
  | {
      readonly notFound: true;
    };

function isFakeAttachNotFound(
  script: FakeCursorAttachScript,
): script is { readonly notFound: true } {
  return "notFound" in script;
}

/** Recorded `attach()` call metadata for post-hoc test assertions. */
export interface FakeCursorAttachCall {
  readonly input: CursorRunAttachInput;
  readonly script: FakeCursorAttachScript;
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
  /** Used when `enqueueAttach()` hasn't been called for an `attach()` invocation. */
  readonly defaultAttachScript?: FakeCursorAttachScript;
}

/**
 * Fake implementation of `CursorRunner`. Construct once, `enqueue()`
 * per expected `run()` call. Without a `defaultScript`, an un-enqueued
 * `run()` throws — loud-failure for misconfigured tests.
 */
export class FakeCursorRunner implements CursorRunner {
  readonly #scripts: FakeCursorScript[] = [];
  readonly #attachScripts: FakeCursorAttachScript[] = [];
  readonly #calls: FakeCursorRunCall[] = [];
  readonly #attachCalls: FakeCursorAttachCall[] = [];
  readonly #defaultScript: FakeCursorScript | undefined;
  readonly #defaultAttachScript: FakeCursorAttachScript | undefined;
  readonly #artifactBytesByAgent = new Map<string, Map<string, Buffer>>();
  #runCounter = 0;

  constructor(opts: FakeCursorRunnerOptions = {}) {
    this.#defaultScript = opts.defaultScript;
    this.#defaultAttachScript = opts.defaultAttachScript;
  }

  /** Append a script to the FIFO queue. */
  enqueue(script: FakeCursorScript): void {
    this.#scripts.push(script);
  }

  /** Append an attach script to the FIFO queue. */
  enqueueAttach(script: FakeCursorAttachScript): void {
    this.#attachScripts.push(script);
  }

  /** All `run()` calls in invocation order. */
  get calls(): readonly FakeCursorRunCall[] {
    return this.#calls;
  }

  /** All `attach()` calls in invocation order. */
  get attachCalls(): readonly FakeCursorAttachCall[] {
    return this.#attachCalls;
  }

  /** Number of scripts still queued (excludes `defaultScript`). */
  get pendingScriptCount(): number {
    return this.#scripts.length;
  }

  run(input: CursorRunInput): Promise<CursorRunHandle> {
    const script = this.#scripts.shift() ?? this.#defaultScript;
    if (script === undefined) {
      return Promise.reject(
        new Error(
          "FakeCursorRunner: run() called with no script enqueued and no defaultScript provided",
        ),
      );
    }
    this.#calls.push({ input, script });

    this.#runCounter += 1;
    const callIndex = this.#runCounter;
    const agentId = `agent-fake-${callIndex.toString().padStart(4, "0")}`;
    if (script.artifactBytes !== undefined) {
      this.#artifactBytesByAgent.set(agentId, new Map(Object.entries(script.artifactBytes)));
    }
    return Promise.resolve(
      this.#buildScriptedHandle({
        agentId,
        input,
        runId: `run-fake-${callIndex.toString().padStart(4, "0")}`,
        script,
      }),
    );
  }

  downloadArtifact(agentId: string, path: string): Promise<Buffer> {
    const perAgent = this.#artifactBytesByAgent.get(agentId);
    const bytes = perAgent?.get(path);
    if (bytes === undefined) {
      throw new CursorAgentNotFoundError({ agentId, runId: "", runtime: "cloud" });
    }
    return Promise.resolve(bytes);
  }

  attach(input: CursorRunAttachInput): Promise<CursorRunHandle> {
    const script = this.#attachScripts.shift() ?? this.#defaultAttachScript;
    if (script === undefined) {
      return Promise.reject(
        new Error(
          "FakeCursorRunner: attach() called with no script enqueued and no defaultAttachScript provided",
        ),
      );
    }
    this.#attachCalls.push({ input, script });

    if (isFakeAttachNotFound(script)) {
      return Promise.reject(
        new CursorAgentNotFoundError({
          agentId: input.agentId,
          runId: input.runId,
          runtime: "cloud",
        }),
      );
    }

    return Promise.resolve(
      this.#buildScriptedHandle({
        agentId: input.agentId,
        input: attachInputAsRunInput(input),
        runId: input.runId,
        script,
      }),
    );
  }

  #buildScriptedHandle(args: {
    agentId: string;
    input: CursorRunInput;
    runId: string;
    script: FakeCursorScript;
  }): CursorRunHandle {
    const { agentId, input, runId, script } = args;
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

    return { agentId, cancel: cancelInternal, result, runId };
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
      if (script.listArtifacts !== undefined) {
        const artifacts = await captureListedArtifacts(script.listArtifacts, input.log);
        finalize(finalizeFakeResult(script, { ...script.result, artifacts }));
        return;
      }
      finalize(finalizeFakeResult(script, script.result));
    }
  }
}

function finalizeFakeResult(script: FakeCursorScript, terminal: CursorRunResult): CursorRunResult {
  if (script.events.length === 0) return terminal;
  // Mirror the runners' tail-retention so tests reflect production eviction.
  return { ...terminal, classificationEvents: script.events.slice(-MAX_CLASSIFICATION_EVENTS) };
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

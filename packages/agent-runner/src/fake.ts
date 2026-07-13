/**
 * `FakeAgentRunner` — scriptable stand-in for production runners.
 * Exported under `@ship/agent-runner/test/fake`. Downstream tests drive
 * it deterministically with no API key and no network.
 */

import type { ArtifactRef } from "@ship/workflow";

import type { AgentEvent } from "./event-projection.js";
import type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunLiveness,
  AgentRunner,
  AgentRunProbeArgs,
  AgentRunProbeResult,
  AgentRunRefreshInput,
  AgentRunResult,
} from "./runner.js";

import { captureListedArtifacts } from "./artifacts-capture.js";
import { attachInputAsRunInput } from "./attach-input.js";
import { AgentNotFoundError } from "./errors.js";
import { MAX_CLASSIFICATION_EVENTS } from "./formatters.js";

/** A single scripted run. The fake pops one of these per `run()` call. */
export interface FakeAgentScript {
  readonly events: readonly AgentEvent[];
  readonly result: AgentRunResult;
  readonly listArtifacts?: () => Promise<readonly ArtifactRef[] | undefined>;
  readonly cancelBehavior?: "complete" | "ignore" | "throw";
  readonly delayMsBetweenEvents?: number;
  readonly artifactBytes?: Readonly<Record<string, Buffer>>;
  /** Server-stamped liveness returned by `probeRun` and seeded on the handle. */
  readonly liveness?: AgentRunLiveness;
  /** Scripted probe answers keyed by `${agentId}:${runId}`. */
  readonly probeResults?: Readonly<Record<string, AgentRunProbeResult | undefined>>;
}

export type FakeAgentAttachScript =
  | FakeAgentScript
  | {
      readonly notFound: true;
    };

function isFakeAttachNotFound(
  script: FakeAgentAttachScript,
): script is { readonly notFound: true } {
  return "notFound" in script;
}

/**
 * One scripted `refreshRun` answer. A bare `AgentRunResult` is a terminal
 * read; `stillRunning` models a run the read found not-yet-terminal (resolves
 * `undefined`); `notFound` models a definitively-gone run (rejects with
 * `AgentNotFoundError`); `error` models a transient read failure (rejects with
 * the given error — the caller should leave the row for a later refresh).
 */
export type FakeAgentRefreshScript =
  | AgentRunResult
  | { readonly stillRunning: true }
  | { readonly notFound: true }
  | { readonly error: Error };

function isFakeRefreshStillRunning(
  script: FakeAgentRefreshScript,
): script is { readonly stillRunning: true } {
  return "stillRunning" in script;
}

function isFakeRefreshNotFound(
  script: FakeAgentRefreshScript,
): script is { readonly notFound: true } {
  return "notFound" in script;
}

function isFakeRefreshError(script: FakeAgentRefreshScript): script is { readonly error: Error } {
  return "error" in script;
}

export interface FakeAgentRefreshCall {
  readonly input: AgentRunRefreshInput;
  readonly script: FakeAgentRefreshScript;
}

export interface FakeAgentAttachCall {
  readonly input: AgentRunAttachInput;
  readonly script: FakeAgentAttachScript;
}

export interface FakeAgentRunCall {
  readonly input: AgentRunInput;
  readonly script: FakeAgentScript;
}

const CANCEL_THROWN_MESSAGE = "FakeAgentRunner: scripted cancel error";

export interface FakeAgentRunnerOptions {
  readonly defaultScript?: FakeAgentScript;
  readonly defaultAttachScript?: FakeAgentAttachScript;
  /** Global probe script when a per-script entry is absent. */
  readonly defaultProbeResult?: AgentRunProbeResult | undefined;
  /** Answer for `refreshRun` when no per-call script is enqueued. */
  readonly defaultRefreshScript?: FakeAgentRefreshScript;
}

export class FakeAgentRunner implements AgentRunner {
  readonly #scripts: FakeAgentScript[] = [];
  readonly #attachScripts: FakeAgentAttachScript[] = [];
  readonly #refreshScripts: FakeAgentRefreshScript[] = [];
  readonly #calls: FakeAgentRunCall[] = [];
  readonly #attachCalls: FakeAgentAttachCall[] = [];
  readonly #refreshCalls: FakeAgentRefreshCall[] = [];
  readonly #defaultScript: FakeAgentScript | undefined;
  readonly #defaultAttachScript: FakeAgentAttachScript | undefined;
  readonly #defaultProbeResult: AgentRunProbeResult | undefined;
  readonly #defaultRefreshScript: FakeAgentRefreshScript | undefined;
  readonly #artifactBytesByAgent = new Map<string, Map<string, Buffer>>();
  readonly #activeLiveness = new Map<string, AgentRunLiveness>();
  readonly #probeScripts = new Map<string, AgentRunProbeResult | undefined>();
  #runCounter = 0;

  constructor(opts: FakeAgentRunnerOptions = {}) {
    this.#defaultScript = opts.defaultScript;
    this.#defaultAttachScript = opts.defaultAttachScript;
    this.#defaultProbeResult = opts.defaultProbeResult;
    this.#defaultRefreshScript = opts.defaultRefreshScript;
  }

  enqueue(script: FakeAgentScript): void {
    this.#scripts.push(script);
  }

  enqueueAttach(script: FakeAgentAttachScript): void {
    this.#attachScripts.push(script);
  }

  enqueueRefresh(script: FakeAgentRefreshScript): void {
    this.#refreshScripts.push(script);
  }

  get calls(): readonly FakeAgentRunCall[] {
    return this.#calls;
  }

  get attachCalls(): readonly FakeAgentAttachCall[] {
    return this.#attachCalls;
  }

  get refreshCalls(): readonly FakeAgentRefreshCall[] {
    return this.#refreshCalls;
  }

  get pendingScriptCount(): number {
    return this.#scripts.length;
  }

  /** Test hook: set a probe answer for a specific agent/run pair. */
  setProbeResult(args: AgentRunProbeArgs, result: AgentRunProbeResult | undefined): void {
    this.#probeScripts.set(probeKey(args), result);
  }

  probeRun(args: AgentRunProbeArgs): Promise<AgentRunProbeResult | undefined> {
    const key = probeKey(args);
    if (this.#probeScripts.has(key)) return Promise.resolve(this.#probeScripts.get(key));
    const active = this.#activeLiveness.get(key);
    if (active?.createdAtMs !== undefined && active.lastEventAtMs !== undefined) {
      return Promise.resolve({
        createdAtMs: active.createdAtMs,
        status: "RUNNING",
        updatedAtMs: active.lastEventAtMs,
      });
    }
    return Promise.resolve(this.#defaultProbeResult);
  }

  run(input: AgentRunInput): Promise<AgentRunHandle> {
    const script = this.#scripts.shift() ?? this.#defaultScript;
    if (script === undefined) {
      return Promise.reject(
        new Error(
          "FakeAgentRunner: run() called with no script enqueued and no defaultScript provided",
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
      throw new AgentNotFoundError({ agentId, runId: "" });
    }
    return Promise.resolve(bytes);
  }

  attach(input: AgentRunAttachInput): Promise<AgentRunHandle> {
    const script = this.#attachScripts.shift() ?? this.#defaultAttachScript;
    if (script === undefined) {
      return Promise.reject(
        new Error(
          "FakeAgentRunner: attach() called with no script enqueued and no defaultAttachScript provided",
        ),
      );
    }
    this.#attachCalls.push({ input, script });

    if (isFakeAttachNotFound(script)) {
      return Promise.reject(new AgentNotFoundError({ agentId: input.agentId, runId: input.runId }));
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

  refreshRun(input: AgentRunRefreshInput): Promise<AgentRunResult | undefined> {
    const script = this.#refreshScripts.shift() ?? this.#defaultRefreshScript;
    if (script === undefined) {
      return Promise.reject(
        new Error(
          "FakeAgentRunner: refreshRun() called with no script enqueued and no defaultRefreshScript provided",
        ),
      );
    }
    this.#refreshCalls.push({ input, script });

    if (isFakeRefreshNotFound(script)) {
      return Promise.reject(new AgentNotFoundError({ agentId: input.agentId, runId: input.runId }));
    }
    if (isFakeRefreshError(script)) {
      return Promise.reject(script.error);
    }
    if (isFakeRefreshStillRunning(script)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(script);
  }

  #buildScriptedHandle(args: {
    agentId: string;
    input: AgentRunInput;
    runId: string;
    script: FakeAgentScript;
  }): AgentRunHandle {
    const { agentId, input, runId, script } = args;
    const livenessState: { createdAtMs?: number; lastEventAtMs?: number } = {
      ...(script.liveness ?? {}),
    };
    this.#activeLiveness.set(probeKey({ agentId, runId }), livenessState);
    if (script.probeResults !== undefined) {
      for (const [key, value] of Object.entries(script.probeResults)) {
        this.#probeScripts.set(key, value);
      }
    }
    let terminated = false;
    let cancelAttempted = false;
    let resolveResult!: (value: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>((resolve) => {
      resolveResult = resolve;
    });

    let activeSleep: { cancel: () => void } | null = null;
    let signalListener: (() => void) | null = null;

    const finalize = (terminal: AgentRunResult): void => {
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

    const cancelInternal = (): Promise<void> => {
      const behavior = script.cancelBehavior ?? "complete";
      if (cancelAttempted) return Promise.resolve();
      cancelAttempted = true;
      if (behavior === "throw" && !terminated) {
        return Promise.reject(new Error(CANCEL_THROWN_MESSAGE));
      }
      if (behavior === "ignore") return Promise.resolve();
      finalize({ ...script.result, status: "cancelled" });
      return Promise.resolve();
    };

    const hardCancelFromSignal = (): void => {
      if (terminated) return;
      cancelAttempted = true;
      finalize({ ...script.result, status: "cancelled" });
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        hardCancelFromSignal();
      } else {
        signalListener = hardCancelFromSignal;
        input.signal.addEventListener("abort", signalListener, { once: true });
      }
    }

    const setActiveSleep = (s: { cancel: () => void } | null): void => {
      activeSleep = s;
    };
    void this.#emit({
      finalize,
      input,
      isTerminated: () => terminated,
      onProviderEvent: (ev) => {
        const ts = eventTimestampMs(ev);
        if (ts === undefined) return;
        livenessState.lastEventAtMs = ts;
        livenessState.createdAtMs ??= ts;
      },
      script,
      setActiveSleep,
    });

    return {
      agentId,
      cancel: cancelInternal,
      liveness: () => ({ ...livenessState }),
      result,
      runId,
    };
  }

  async #emit(args: {
    script: FakeAgentScript;
    input: AgentRunInput;
    isTerminated: () => boolean;
    finalize: (terminal: AgentRunResult) => void;
    setActiveSleep: (s: { cancel: () => void } | null) => void;
    onProviderEvent?: (ev: AgentEvent) => void;
  }): Promise<void> {
    const { script, input, isTerminated, finalize, setActiveSleep, onProviderEvent } = args;
    const delay = script.delayMsBetweenEvents ?? 0;
    for (const ev of script.events) {
      if (delay > 0) {
        const s = abortableSleep(delay);
        setActiveSleep(s);
        await s.promise;
        setActiveSleep(null);
      }
      if (isTerminated()) return;
      deliverProviderEvent(input, ev, onProviderEvent);
    }
    if (!isTerminated()) {
      await finalizeScriptedRun(script, input, finalize);
    }
  }
}

function deliverProviderEvent(
  input: AgentRunInput,
  ev: AgentEvent,
  onProviderEvent?: (ev: AgentEvent) => void,
): void {
  onProviderEvent?.(ev);
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

async function finalizeScriptedRun(
  script: FakeAgentScript,
  input: AgentRunInput,
  finalize: (terminal: AgentRunResult) => void,
): Promise<void> {
  if (script.listArtifacts !== undefined) {
    const artifacts = await captureListedArtifacts(script.listArtifacts, input.log);
    const terminal = artifacts.length > 0 ? { ...script.result, artifacts } : script.result;
    finalize(finalizeFakeResult(script, terminal));
    return;
  }
  finalize(finalizeFakeResult(script, script.result));
}

function probeKey(args: AgentRunProbeArgs): string {
  return `${args.agentId}:${args.runId}`;
}

function eventTimestampMs(ev: AgentEvent): number | undefined {
  const raw = ev as { ts?: unknown; startedAt?: unknown };
  const ts = raw.ts ?? raw.startedAt;
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

function finalizeFakeResult(script: FakeAgentScript, terminal: AgentRunResult): AgentRunResult {
  if (script.events.length === 0) return terminal;
  return { ...terminal, classificationEvents: script.events.slice(-MAX_CLASSIFICATION_EVENTS) };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

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

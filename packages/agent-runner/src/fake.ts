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
  AgentRunner,
  AgentRunResult,
} from "./runner.js";

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
}

export class FakeAgentRunner implements AgentRunner {
  readonly #scripts: FakeAgentScript[] = [];
  readonly #attachScripts: FakeAgentAttachScript[] = [];
  readonly #calls: FakeAgentRunCall[] = [];
  readonly #attachCalls: FakeAgentAttachCall[] = [];
  readonly #defaultScript: FakeAgentScript | undefined;
  readonly #defaultAttachScript: FakeAgentAttachScript | undefined;
  readonly #artifactBytesByAgent = new Map<string, Map<string, Buffer>>();
  #runCounter = 0;

  constructor(opts: FakeAgentRunnerOptions = {}) {
    this.#defaultScript = opts.defaultScript;
    this.#defaultAttachScript = opts.defaultAttachScript;
  }

  enqueue(script: FakeAgentScript): void {
    this.#scripts.push(script);
  }

  enqueueAttach(script: FakeAgentAttachScript): void {
    this.#attachScripts.push(script);
  }

  get calls(): readonly FakeAgentRunCall[] {
    return this.#calls;
  }

  get attachCalls(): readonly FakeAgentAttachCall[] {
    return this.#attachCalls;
  }

  get pendingScriptCount(): number {
    return this.#scripts.length;
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

  #buildScriptedHandle(args: {
    agentId: string;
    input: AgentRunInput;
    runId: string;
    script: FakeAgentScript;
  }): AgentRunHandle {
    const { agentId, input, runId, script } = args;
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
    void this.#emit(script, input, () => terminated, finalize, setActiveSleep);

    return { agentId, cancel: cancelInternal, result, runId };
  }

  async #emit(
    script: FakeAgentScript,
    input: AgentRunInput,
    isTerminated: () => boolean,
    finalize: (terminal: AgentRunResult) => void,
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
        const artifacts = await script.listArtifacts();
        const terminal = artifacts !== undefined ? { ...script.result, artifacts } : script.result;
        finalize(finalizeFakeResult(script, terminal));
        return;
      }
      finalize(finalizeFakeResult(script, script.result));
    }
  }
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

/**
 * `LocalCursorRunner` — the only runtime user of `@cursor/sdk` in the
 * monorepo (per ED-2). Drives a local Cursor agent via
 * `Agent.create({ local: { cwd } })`, streams events to `onEvent`,
 * resolves `handle.result` on terminal status. See
 * `phases/05-cursor-runner.md` for the full contract.
 */

import type { AgentOptions, Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";

import { Agent } from "@cursor/sdk";

import type { MapRunResultOptions } from "./_shared.js";
import type {
  CursorRunAttachInput,
  CursorRunHandle,
  CursorRunInput,
  CursorRunner,
  CursorRunResult,
} from "./runner.js";

import { mapRunResult } from "./_shared.js";
import {
  CursorRunFailedError,
  cursorRunFailedError,
  LocalResumeNotSupportedError,
  MissingApiKeyError,
  WrongRunnerError,
} from "./errors.js";

const API_KEY_ENV = "CURSOR_API_KEY";

/** Construct once, reuse across runs. The runner holds no per-run state. */
export class LocalCursorRunner implements CursorRunner {
  async run(input: CursorRunInput): Promise<CursorRunHandle> {
    if (input.runtime !== undefined && input.runtime !== "local") {
      throw new WrongRunnerError(
        `LocalCursorRunner accepts runtime: "local" or undefined; received: ${JSON.stringify(input.runtime)}`,
      );
    }
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError();
    }
    const { agent, sdkRun } = await this.#startAgent(apiKey, input);
    return this.#buildHandle(agent, sdkRun, input);
  }

  attach(input: CursorRunAttachInput): Promise<CursorRunHandle> {
    return Promise.reject(new LocalResumeNotSupportedError({ agentId: input.agentId }));
  }

  /**
   * Creates the SDK agent and submits the first prompt. Pre-run
   * failures wrap as `CursorRunFailedError`; if `Agent.create` succeeded
   * but `agent.send` threw, we dispose the agent before re-throwing.
   */
  async #startAgent(
    apiKey: string,
    input: CursorRunInput,
  ): Promise<{ agent: SDKAgent; sdkRun: Run }> {
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.create({
        apiKey,
        // Reconstruct `model` field-by-field — workflow's mirror and
        // SDK's `ModelSelection` are structurally identical at runtime,
        // but `exactOptionalPropertyTypes` rejects the cross-type
        // assignment until we cast across the shim boundary (the SDK types
        // still model `value` as string-only — booleans are accepted via
        // runtime JSON from upstream callers).
        model: {
          id: input.model.id,
          ...(input.model.params !== undefined && { params: input.model.params }),
        } as NonNullable<AgentOptions["model"]>,
        local: { cwd: input.cwd, settingSources: ["project"] },
        ...(input.agents !== undefined && { agents: input.agents }),
        ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
        ...(input.agentName !== undefined && { name: input.agentName }),
      });
      const sdkRun = await agent.send(input.prompt);
      return { agent, sdkRun };
    } catch (err) {
      if (agent !== undefined) {
        try {
          await agent[Symbol.asyncDispose]();
        } catch {
          /* swallow secondary dispose error */
        }
      }
      throw new CursorRunFailedError(
        agent === undefined ? "Agent.create failed" : "agent.send failed after Agent.create",
        { cause: err },
      );
    }
  }

  /**
   * Wires the SDK run into a `CursorRunHandle`. Cancellation funnels
   * through one internal pipeline guarded by `terminated` (cancel-after-
   * terminal) and `cancelInitiated` (concurrent cancel races); the
   * latter resets on SDK-cancel rejection so transient failures don't
   * permanently disable cancel.
   */
  #buildHandle(agent: SDKAgent, sdkRun: Run, input: CursorRunInput): CursorRunHandle {
    let terminated = false;
    let cancelInitiated = false;
    let resolveResult!: (value: CursorRunResult) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<CursorRunResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    let signalListener: (() => void) | undefined;
    const detachSignalListener = (): void => {
      if (signalListener !== undefined && input.signal !== undefined) {
        input.signal.removeEventListener("abort", signalListener);
      }
      signalListener = undefined;
    };

    const cancelInternal = async (): Promise<void> => {
      if (terminated || cancelInitiated) return;
      cancelInitiated = true;
      try {
        await sdkRun.cancel();
      } catch {
        // Allow retries: a transient SDK-side failure shouldn't
        // permanently disable cancel while the run is still live.
        cancelInitiated = false;
      }
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        void cancelInternal();
      } else {
        signalListener = (): void => {
          void cancelInternal();
        };
        input.signal.addEventListener("abort", signalListener, { once: true });
      }
    }

    void this.#runPipeline(agent, sdkRun, input, {
      detachSignalListener,
      finalizeError: (err) => {
        if (terminated) return;
        terminated = true;
        detachSignalListener();
        rejectResult(err);
      },
      finalizeOk: (terminal) => {
        if (terminated) return;
        terminated = true;
        detachSignalListener();
        resolveResult(terminal);
      },
    });

    return {
      agentId: agent.agentId,
      cancel: cancelInternal,
      result,
      runId: sdkRun.id,
    };
  }

  /**
   * Background pipeline: stream events, await `run.wait()`, map to
   * Ship vocabulary, dispose the agent in `finally` regardless of
   * outcome.
   */
  async #runPipeline(
    agent: SDKAgent,
    sdkRun: Run,
    input: CursorRunInput,
    callbacks: {
      finalizeOk: (terminal: CursorRunResult) => void;
      finalizeError: (err: unknown) => void;
      detachSignalListener: () => void;
    },
  ): Promise<void> {
    /**
     * Calls `onEvent` once and swallows both sync throws and async
     * rejections (ED-4). Extracted so the for-await body stays shallow.
     */
    const safelyEmit = (ev: SDKMessage): void => {
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
    };

    // Bound retained events: a long run can stream thousands, but the failure
    // mapper only needs the tail (last status + last error-bearing tool_call).
    const MAX_CAPTURED_EVENTS = 256;
    const capturedEvents: SDKMessage[] = [];
    const recordEvent = (ev: SDKMessage): void => {
      capturedEvents.push(ev);
      if (capturedEvents.length > MAX_CAPTURED_EVENTS) capturedEvents.shift();
    };
    const mapOpts = (): MapRunResultOptions => ({ events: capturedEvents });

    try {
      try {
        for await (const ev of sdkRun.stream()) {
          recordEvent(ev);
          safelyEmit(ev);
        }
      } catch (streamErr) {
        // Stream errored before wait() observed a terminal. Try wait()
        // anyway — if the SDK has a terminal for us, prefer it.
        const result = await this.#tryWait(sdkRun);
        if (result !== undefined) {
          callbacks.finalizeOk(mapRunResult(result, input, undefined, mapOpts()));
          return;
        }
        callbacks.finalizeError(
          cursorRunFailedError("stream errored without a terminal RunResult", streamErr),
        );
        return;
      }

      // wait() can reject after a clean stream. Catch here so the
      // rejection doesn't escape via `void this.#runPipeline(...)`.
      let waitResult: RunResult;
      try {
        waitResult = await sdkRun.wait();
      } catch (waitErr) {
        callbacks.finalizeError(
          cursorRunFailedError("run.wait() rejected after a clean stream", waitErr),
        );
        return;
      }
      callbacks.finalizeOk(mapRunResult(waitResult, input, undefined, mapOpts()));
    } finally {
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        /* swallow */
      }
      callbacks.detachSignalListener();
    }
  }

  /** Best-effort `run.wait()` after a stream error. `undefined` if `wait()` itself rejects. */
  async #tryWait(sdkRun: Run): Promise<RunResult | undefined> {
    try {
      return await sdkRun.wait();
    } catch {
      return undefined;
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

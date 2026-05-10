/**
 * `LocalCursorRunner` — the only runtime user of `@cursor/sdk` in the
 * monorepo (per ED-2).
 *
 * Drives a local Cursor agent (`Agent.create({ local: { cwd } })`),
 * streams SDK events to the consumer's `onEvent`, and resolves the
 * handle's `result` once the SDK reports a terminal status. Every line
 * of code in the package that names `@cursor/sdk` at runtime lives in
 * this file; consumers (`core`, `mcp-server`) never import the SDK
 * directly.
 *
 * V1 ships local-only. V2 will add `CloudCursorRunner` as a separate
 * class behind the same `CursorRunner` interface — substrate
 * polymorphism is structural, not a discriminator field.
 *
 * Behavioral contracts (validation plan in `phases/05-cursor-runner.md`):
 * - `CURSOR_API_KEY` is read at `run()` time. Env-only, never persisted
 *   on `this`, the input, the handle, or any artifact (ED-1).
 * - `Agent.create` / `agent.send` failures are wrapped in
 *   `CursorRunFailedError`. If the agent was created but `send` threw,
 *   the agent IS disposed in the catch path.
 * - `RunResult.status === "error"` resolves the handle's `result` with
 *   `status: "failed"`, NOT a throw (per the error policy split).
 * - Cancellation via `signal` and `handle.cancel()` both funnel through
 *   the same internal pipeline and are idempotent (a `terminated` flag
 *   gates duplicate calls; SDK's `run.cancel()` is invoked at most once).
 * - `onEvent` exceptions are caught and silently swallowed (ED-4 — fire-
 *   and-forget contract; consumers that need visibility queue async
 *   work themselves).
 * - `agent[Symbol.asyncDispose]()` runs in a finally regardless of
 *   stream success, throw, or cancel.
 */

import type { Run, RunResult, SDKAgent } from "@cursor/sdk";

import { Agent } from "@cursor/sdk";

import type { CursorRunHandle, CursorRunInput, CursorRunner, CursorRunResult } from "./runner.js";

import { CursorRunFailedError, MissingApiKeyError } from "./errors.js";

/** Env var the runner reads on every `run()` call. */
const API_KEY_ENV = "CURSOR_API_KEY";

/**
 * SDK-agnostic runner for local Cursor agents.
 *
 * Construct once, reuse across runs — the runner holds no per-run state
 * itself; every `run()` returns a fresh handle bound to a fresh SDK
 * agent. Cross-run state (workflow ids, archived runs, etc.) is `core`'s
 * concern.
 */
export class LocalCursorRunner implements CursorRunner {
  async run(input: CursorRunInput): Promise<CursorRunHandle> {
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError();
    }

    const { agent, sdkRun } = await this.#startAgent(apiKey, input);

    return this.#buildHandle(agent, sdkRun, input);
  }

  /**
   * Creates the SDK agent and submits the first prompt. Pre-run failures
   * (either `Agent.create` or `agent.send` throwing) surface as
   * `CursorRunFailedError`; if the agent was created before the throw,
   * we dispose it before re-throwing.
   */
  async #startAgent(
    apiKey: string,
    input: CursorRunInput,
  ): Promise<{ agent: SDKAgent; sdkRun: Run }> {
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.create({
        apiKey,
        // Reconstruct `model` field-by-field rather than passing
        // `input.model` straight through. The SDK's `ModelSelection`
        // and `@ship/workflow`'s mirror are structurally identical at
        // runtime, but TypeScript's `exactOptionalPropertyTypes`
        // refuses the cross-type assignment (workflow's expanded type
        // has `params?: T[] | undefined`, SDK's is `params?: T[]`).
        // Conditional-spreading the optional field is the cleanest
        // fix — no `as` cast, no precision loss.
        model: {
          id: input.model.id,
          ...(input.model.params !== undefined && { params: input.model.params }),
        },
        local: { cwd: input.cwd },
        ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
        ...(input.agentName !== undefined && { name: input.agentName }),
      });
      const sdkRun = await agent.send(input.prompt);
      return { agent, sdkRun };
    } catch (err) {
      if (agent !== undefined) {
        // We created the agent but agent.send threw — release it before
        // re-throwing so the SDK doesn't leak a wedged session. Disposal
        // failure is swallowed: the originating SDK error is what the
        // caller cares about.
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
   * Wires the SDK run into a `CursorRunHandle`: the streaming + wait +
   * dispose pipeline runs in the background; cancel paths funnel through
   * a single internal cancel function with a `terminated` guard for
   * idempotency.
   */
  #buildHandle(agent: SDKAgent, sdkRun: Run, input: CursorRunInput): CursorRunHandle {
    let terminated = false;
    // Distinct from `terminated`: tracks whether we've already invoked
    // `sdkRun.cancel()` so concurrent cancel calls (signal + handle,
    // multiple handle.cancel() races) don't fan out duplicate SDK
    // cancels. The flag flips before the await so even synchronous
    // re-entry sees it.
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

    /**
     * Single cancel pipeline. Idempotent via the `terminated` (set by
     * the pipeline after `wait()` returns) and `cancelInitiated` (set
     * here) guards. The terminated check absorbs cancel-after-terminal;
     * the cancelInitiated check absorbs concurrent cancel races.
     */
    const cancelInternal = async (): Promise<void> => {
      if (terminated || cancelInitiated) return;
      cancelInitiated = true;
      try {
        await sdkRun.cancel();
      } catch {
        // SDK cancel-after-terminal behavior is unverified per spike #1
        // findings; swallow defensively. The pipeline's `terminated`
        // flag is the source of truth for whether the run actually
        // ended.
      }
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        // Pre-aborted: kick the cancel synchronously before we start the
        // stream so the SDK sees it as early as possible. The pipeline
        // below will still run wait() and observe the cancelled status.
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
   * Background pipeline: stream events, await `run.wait()` for the
   * structured result, map to Ship's vocabulary, dispose the agent.
   * Disposal happens in a `finally` regardless of how the stream ended.
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
    try {
      try {
        for await (const ev of sdkRun.stream()) {
          try {
            input.onEvent(ev);
          } catch {
            // ED-4: onEvent exceptions are swallowed at the runner
            // boundary; the SDK run is unaffected.
          }
        }
      } catch (streamErr) {
        // Stream itself errored before run.wait could observe a terminal
        // status. Still try to wait — if the SDK has a terminal result
        // for us, prefer that. Otherwise propagate.
        const result = await this.#tryWait(sdkRun);
        if (result !== undefined) {
          callbacks.finalizeOk(mapRunResult(result, input));
          return;
        }
        callbacks.finalizeError(
          new CursorRunFailedError("stream errored without a terminal RunResult", {
            cause: streamErr,
          }),
        );
        return;
      }

      const result = await sdkRun.wait();
      callbacks.finalizeOk(mapRunResult(result, input));
    } finally {
      // Dispose regardless. Disposal failures don't change the run's
      // outcome — they're SDK cleanup concerns surfaced via stderr if
      // the SDK chooses to log them. We don't propagate.
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        /* swallow */
      }
      // Belt and suspenders: detach the signal listener if `finalizeOk` /
      // `finalizeError` somehow short-circuited (shouldn't happen).
      callbacks.detachSignalListener();
    }
  }

  /**
   * Best-effort `run.wait()` after a stream error. Returns `undefined`
   * if `wait()` itself rejects — in that case the caller propagates the
   * original stream error.
   */
  async #tryWait(sdkRun: Run): Promise<RunResult | undefined> {
    try {
      return await sdkRun.wait();
    } catch {
      return undefined;
    }
  }
}

/**
 * Maps `RunResult` (SDK vocabulary) to `CursorRunResult` (Ship
 * vocabulary). Per ED-3 the mapping lives here, not in `core`.
 *
 * - `RunResult.status: "finished"` → `"succeeded"`
 * - `"error"` → `"failed"` with `errorMessage` populated from
 *   `RunResult.result` (the SDK surfaces the error text there)
 * - `"cancelled"` → `"cancelled"`
 */
function mapRunResult(result: RunResult, input: CursorRunInput): CursorRunResult {
  const branches = result.git?.branches ?? [];
  const durationMs = result.durationMs ?? 0;

  if (result.status === "finished") {
    return {
      branches,
      durationMs,
      ...(result.model !== undefined && { model: result.model }),
      status: "succeeded",
      ...(result.result !== undefined && { summary: result.result }),
    };
  }
  if (result.status === "cancelled") {
    return {
      branches,
      durationMs,
      ...(result.model !== undefined && { model: result.model }),
      status: "cancelled",
      ...(result.result !== undefined && { summary: result.result }),
    };
  }
  // status === "error"
  return {
    branches,
    durationMs,
    // `input.model` is required on `CursorRunInput`, so we always have
    // something to fall back to if the SDK omits `result.model` on error.
    model: result.model ?? input.model,
    errorMessage: result.result ?? "Cursor SDK reported error without a message",
    status: "failed",
  };
}

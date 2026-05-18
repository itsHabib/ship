/**
 * `CloudCursorRunner` — drives a Cursor cloud agent via
 * `Agent.create({ cloud: { repos, ... } })`. Mirrors `LocalCursorRunner`'s
 * pipeline shape; see phase 04 design (`04-cursor-cloud-runner.md`).
 */

import type {
  CloudAgentOptions,
  ModelSelection,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage,
} from "@cursor/sdk";

import { Agent, IntegrationNotConnectedError } from "@cursor/sdk";

import type {
  CloudRunSpec,
  CursorRunHandle,
  CursorRunInput,
  CursorRunner,
  CursorRunResult,
} from "./runner.js";

import { mapRunResult, mapTerminalResult } from "./_shared.js";
import {
  CursorCloudIntegrationError,
  CursorRunFailedError,
  EmptyCloudReposError,
  MissingApiKeyError,
  MissingCloudSpecError,
  WrongRunnerError,
} from "./errors.js";

const API_KEY_ENV = "CURSOR_API_KEY";

function modelArgFromInput(input: CursorRunInput): ModelSelection {
  return {
    id: input.model.id,
    ...(input.model.params !== undefined && { params: input.model.params }),
  };
}

function cloudAgentOptions(spec: CloudRunSpec): CloudAgentOptions {
  return {
    repos: [...spec.repos],
    ...(spec.workOnCurrentBranch !== undefined && {
      workOnCurrentBranch: spec.workOnCurrentBranch,
    }),
    ...(spec.autoCreatePR !== undefined && { autoCreatePR: spec.autoCreatePR }),
    ...(spec.skipReviewerRequest !== undefined && {
      skipReviewerRequest: spec.skipReviewerRequest,
    }),
    ...(spec.envVars !== undefined && { envVars: spec.envVars }),
    ...(spec.env !== undefined && { env: spec.env }),
  };
}

function mapCloudRunResult(result: RunResult, input: CursorRunInput): CursorRunResult {
  // `@cursor/sdk` RunResult typings omit "expired" as of 1.0.x; cloud may still surface it.
  if (((result.status as string | undefined) ?? "").toLowerCase() === "expired") {
    return mapTerminalResult(result, "cancelled");
  }
  return mapRunResult(result, input);
}

/** Construct once, reuse across runs. The runner holds no per-run state. */
export class CloudCursorRunner implements CursorRunner {
  async run(input: CursorRunInput): Promise<CursorRunHandle> {
    if (input.runtime !== "cloud") {
      throw new WrongRunnerError('CloudCursorRunner requires input.runtime === "cloud"');
    }
    if (input.cloud === undefined) {
      throw new MissingCloudSpecError();
    }
    // Runtime guard for non-TS callers; `repos` is typed as a 1-tuple for normal TS usage.
    if ((input.cloud.repos as readonly unknown[]).length === 0) {
      throw new EmptyCloudReposError();
    }
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError();
    }
    const { agent, sdkRun } = await this.#startAgent(apiKey, input.cloud, input);
    return this.#buildHandle(agent, sdkRun, input);
  }

  async #startAgent(
    apiKey: string,
    cloudSpec: CloudRunSpec,
    input: CursorRunInput,
  ): Promise<{ agent: SDKAgent; sdkRun: Run }> {
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.create({
        apiKey,
        cloud: cloudAgentOptions(cloudSpec),
        model: modelArgFromInput(input),
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
      if (err instanceof IntegrationNotConnectedError) {
        throw new CursorCloudIntegrationError(err.provider, err.helpUrl, { cause: err });
      }
      throw new CursorRunFailedError(
        agent === undefined ? "Agent.create failed" : "agent.send failed after Agent.create",
        { cause: err },
      );
    }
  }

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

    try {
      try {
        for await (const ev of sdkRun.stream()) {
          safelyEmit(ev);
        }
      } catch (streamErr) {
        const wr = await this.#tryWait(sdkRun);
        if (wr !== undefined) {
          callbacks.finalizeOk(mapCloudRunResult(wr, input));
          return;
        }
        callbacks.finalizeError(
          new CursorRunFailedError("stream errored without a terminal RunResult", {
            cause: streamErr,
          }),
        );
        return;
      }

      let waitResult: RunResult;
      try {
        waitResult = await sdkRun.wait();
      } catch (waitErr) {
        callbacks.finalizeError(
          new CursorRunFailedError("run.wait() rejected after a clean stream", {
            cause: waitErr,
          }),
        );
        return;
      }
      callbacks.finalizeOk(mapCloudRunResult(waitResult, input));
    } finally {
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        /* swallow */
      }
      callbacks.detachSignalListener();
    }
  }

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

/**
 * `LocalCursorRunner` — the primary local runtime user of `@cursor/sdk` in
 * the monorepo (per ED-2). Drives a local Cursor agent via
 * `Agent.create({ local: { cwd } })`, streams events to `onEvent`,
 * resolves `handle.result` on terminal status.
 */

import type { AgentOptions, Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";

import { Agent } from "@cursor/sdk";
import {
  AgentRunFailedError,
  agentRunFailedError,
  buildSdkRunHandle,
  createSdkRunHandleState,
  MissingApiKeyError,
} from "@ship/agent-runner";

import type { MapRunResultOptions } from "./_shared.js";
import type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
} from "./runner.js";

import { mapRunResult, MAX_CLASSIFICATION_EVENTS } from "./_shared.js";
import { LocalResumeNotSupportedError, WrongRunnerError } from "./errors.js";

const API_KEY_ENV = "CURSOR_API_KEY";

export class LocalCursorRunner implements AgentRunner {
  async run(input: AgentRunInput): Promise<AgentRunHandle> {
    if (input.runtime !== undefined && input.runtime !== "local") {
      throw new WrongRunnerError(
        `LocalCursorRunner accepts runtime: "local" or undefined; received: ${JSON.stringify(input.runtime)}`,
      );
    }
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError(`${API_KEY_ENV} environment variable is not set`);
    }
    const { agent, sdkRun } = await this.#startAgent(apiKey, input);
    return this.#buildHandle(agent, sdkRun, input);
  }

  attach(input: AgentRunAttachInput): Promise<AgentRunHandle> {
    return Promise.reject(new LocalResumeNotSupportedError({ agentId: input.agentId }));
  }

  async #startAgent(
    apiKey: string,
    input: AgentRunInput,
  ): Promise<{ agent: SDKAgent; sdkRun: Run }> {
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.create({
        apiKey,
        model: {
          id: input.model.id,
          ...(input.model.params !== undefined && { params: input.model.params }),
        } as NonNullable<AgentOptions["model"]>,
        local: { cwd: input.cwd, settingSources: ["project"] },
        ...(input.agents !== undefined && {
          agents: input.agents as NonNullable<AgentOptions["agents"]>,
        }),
        ...(input.mcpServers !== undefined && {
          mcpServers: input.mcpServers as NonNullable<AgentOptions["mcpServers"]>,
        }),
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
      throw new AgentRunFailedError(
        agent === undefined ? "Agent.create failed" : "agent.send failed after Agent.create",
        { cause: err },
      );
    }
  }

  #buildHandle(agent: SDKAgent, sdkRun: Run, input: AgentRunInput): AgentRunHandle {
    const state = createSdkRunHandleState({
      cancelRun: () => sdkRun.cancel(),
      ...(input.signal !== undefined && { signal: input.signal }),
    });

    void this.#runPipeline(agent, sdkRun, input, state.callbacks);

    return buildSdkRunHandle({
      agentId: agent.agentId,
      runId: sdkRun.id,
      state,
    });
  }

  async #runPipeline(
    agent: SDKAgent,
    sdkRun: Run,
    input: AgentRunInput,
    callbacks: {
      finalizeOk: (terminal: AgentRunResult) => void;
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

    const capturedEvents: SDKMessage[] = [];
    const recordEvent = (ev: SDKMessage): void => {
      capturedEvents.push(ev);
      if (capturedEvents.length > MAX_CLASSIFICATION_EVENTS) capturedEvents.shift();
    };
    const mapOpts = (): MapRunResultOptions => ({ events: capturedEvents });

    try {
      try {
        for await (const ev of sdkRun.stream()) {
          recordEvent(ev);
          safelyEmit(ev);
        }
      } catch (streamErr) {
        const result = await this.#tryWait(sdkRun);
        if (result !== undefined) {
          callbacks.finalizeOk(mapRunResult(result, input, undefined, mapOpts()));
          return;
        }
        callbacks.finalizeError(
          agentRunFailedError("stream errored without a terminal RunResult", streamErr),
        );
        return;
      }

      let waitResult: RunResult;
      try {
        waitResult = await sdkRun.wait();
      } catch (waitErr) {
        callbacks.finalizeError(
          agentRunFailedError("run.wait() rejected after a clean stream", waitErr),
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

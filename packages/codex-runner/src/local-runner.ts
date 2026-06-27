/**
 * `CodexRunner` — local runtime user of `@openai/codex-sdk`.
 * Drives a local Codex agent via `startThread()` + `runStreamed()`, streams
 * events to `onEvent`, resolves `handle.result` on terminal turn event.
 */

import type { CodexOptions, Thread, ThreadEvent } from "@openai/codex-sdk";

import { Codex } from "@openai/codex-sdk";
import {
  AgentRunFailedError,
  buildSdkRunHandle,
  createSdkRunHandleState,
  MissingApiKeyError,
} from "@ship/agent-runner";
import { randomUUID } from "node:crypto";

import type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
} from "./runner.js";

import { codexEventProjection } from "./codex-event-projection.js";
import {
  OperationNotSupportedError,
  UnsupportedPlatformError,
  WrongRunnerError,
} from "./errors.js";
import {
  mapCancelled,
  mapMidStreamFailure,
  mapStreamEndWithoutTerminal,
  mapTerminalEvent,
  MAX_CLASSIFICATION_EVENTS,
} from "./terminal-map.js";

const API_KEY_ENV_PRIMARY = "CODEX_API_KEY";
const API_KEY_ENV_FALLBACK = "OPENAI_API_KEY";
const BASE_URL_ENV_PRIMARY = "CODEX_BASE_URL";
const BASE_URL_ENV_FALLBACK = "OPENAI_BASE_URL";
const MODEL_PROVIDER_ENV = "CODEX_MODEL_PROVIDER";
const MODEL_PROVIDER_BASE_URL_ENV = "CODEX_MODEL_PROVIDER_BASE_URL";
const MODEL_PROVIDER_ENV_KEY_ENV = "CODEX_MODEL_PROVIDER_ENV_KEY";

const SUPPORTED_PLATFORM_KEYS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

const PLATFORM_ARCH_SUFFIX: Record<string, Record<string, string>> = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
  win32: { arm64: "win32-arm64", x64: "win32-x64" },
};

function platformBinarySuffix(): string | undefined {
  const { platform, arch } = process;
  return PLATFORM_ARCH_SUFFIX[platform]?.[arch];
}

function assertPlatformSupported(): void {
  const suffix = platformBinarySuffix();
  if (suffix === undefined || !SUPPORTED_PLATFORM_KEYS.has(suffix)) {
    throw new UnsupportedPlatformError(process.platform, process.arch);
  }
}

function readApiKey(): string | undefined {
  const primary = process.env[API_KEY_ENV_PRIMARY];
  if (primary !== undefined && primary !== "") return primary;
  const fallback = process.env[API_KEY_ENV_FALLBACK];
  if (fallback !== undefined && fallback !== "") return fallback;
  return undefined;
}

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  return value;
}

function buildGatewayConfig(): CodexOptions["config"] | undefined {
  const providerId = readEnvString(MODEL_PROVIDER_ENV);
  const providerBaseUrl = readEnvString(MODEL_PROVIDER_BASE_URL_ENV);
  const providerEnvKey = readEnvString(MODEL_PROVIDER_ENV_KEY_ENV);
  if (providerId !== undefined && providerBaseUrl !== undefined && providerEnvKey !== undefined) {
    return {
      model_provider: providerId,
      model_providers: {
        [providerId]: {
          base_url: providerBaseUrl,
          env_key: providerEnvKey,
          // Codex only supports the Responses API (since 2026-02); a
          // Chat-Completions-only gateway is unsupported. Hardcoded until/unless
          // the SDK gains Chat-Completions support (claude review).
          wire_api: "responses",
        },
      },
    };
  }
  // None set → no custom gateway (run against the default endpoint).
  if (providerId === undefined && providerBaseUrl === undefined && providerEnvKey === undefined) {
    return undefined;
  }
  // Partial config (some but not all three) is almost always a typo or omission —
  // fail loudly rather than silently ignoring it and running against the default
  // endpoint, which the operator did not intend (claude review).
  const missing = [
    providerId === undefined ? MODEL_PROVIDER_ENV : undefined,
    providerBaseUrl === undefined ? MODEL_PROVIDER_BASE_URL_ENV : undefined,
    providerEnvKey === undefined ? MODEL_PROVIDER_ENV_KEY_ENV : undefined,
  ].filter((name): name is string => name !== undefined);
  throw new AgentRunFailedError(
    `incomplete codex gateway config: set all of ${MODEL_PROVIDER_ENV}, ${MODEL_PROVIDER_BASE_URL_ENV}, ${MODEL_PROVIDER_ENV_KEY_ENV} (missing: ${missing.join(", ")})`,
  );
}

function buildCodexOptions(apiKey: string): CodexOptions {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  const options: CodexOptions = { apiKey, env };
  const baseUrl = readEnvString(BASE_URL_ENV_PRIMARY) ?? readEnvString(BASE_URL_ENV_FALLBACK);
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  const config = buildGatewayConfig();
  if (config !== undefined) options.config = config;
  return options;
}

function buildThreadOptions(
  input: AgentRunInput,
): NonNullable<Parameters<Codex["startThread"]>[0]> {
  return {
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    skipGitRepoCheck: false,
    workingDirectory: input.cwd,
    ...(input.model.id.length > 0 && { model: input.model.id }),
  };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function validateRunInput(input: AgentRunInput): string {
  if (input.runtime !== undefined && input.runtime !== "local") {
    throw new WrongRunnerError(
      `CodexRunner accepts runtime: "local" or undefined; received: ${JSON.stringify(input.runtime)}`,
    );
  }
  const apiKey = readApiKey();
  if (apiKey === undefined) {
    throw new MissingApiKeyError(
      `${API_KEY_ENV_PRIMARY} or ${API_KEY_ENV_FALLBACK} environment variable is not set`,
    );
  }
  return apiKey;
}

async function consumeEventStream(
  thread: Thread,
  input: AgentRunInput,
  abortController: AbortController,
  callbacks: {
    finalizeOk: (terminal: AgentRunResult) => void;
  },
): Promise<void> {
  const capturedEvents: ThreadEvent[] = [];
  const recordEvent = (ev: ThreadEvent): void => {
    capturedEvents.push(ev);
    if (capturedEvents.length > MAX_CLASSIFICATION_EVENTS) capturedEvents.shift();
  };

  const safelyEmit = (ev: ThreadEvent): void => {
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

  const startedAt = Date.now();
  try {
    const streamed = await thread.runStreamed(input.prompt, { signal: abortController.signal });
    let lastTerminal: ThreadEvent | undefined;
    for await (const ev of streamed.events) {
      recordEvent(ev);
      safelyEmit(ev);
      if (codexEventProjection.terminalStatus(ev) !== undefined) lastTerminal = ev;
    }
    const durationMs = Date.now() - startedAt;
    if (abortController.signal.aborted) {
      callbacks.finalizeOk(mapCancelled(durationMs));
      return;
    }
    if (lastTerminal !== undefined) {
      callbacks.finalizeOk(mapTerminalEvent(lastTerminal, input, capturedEvents, durationMs));
      return;
    }
    callbacks.finalizeOk(mapStreamEndWithoutTerminal(input, capturedEvents, durationMs));
  } catch (streamErr) {
    const durationMs = Date.now() - startedAt;
    // A cancel (handle.cancel() / input.signal) aborts the controller, so the SDK
    // rejects the stream with an abort error — surface that as cancelled, not a
    // failure, so a user cancellation isn't recorded as failed (codex review).
    if (abortController.signal.aborted) {
      callbacks.finalizeOk(mapCancelled(durationMs));
      return;
    }
    callbacks.finalizeOk(mapMidStreamFailure(streamErr, input, capturedEvents, durationMs));
  }
}

export class CodexRunner implements AgentRunner {
  constructor() {
    assertPlatformSupported();
  }

  run(input: AgentRunInput): Promise<AgentRunHandle> {
    return Promise.resolve().then(() => {
      const apiKey = validateRunInput(input);
      const runId = randomUUID();
      const abortController = new AbortController();

      // buildCodexOptions validates the gateway config and throws a clear
      // AgentRunFailedError on partial config — kept OUT of the try below so that
      // message surfaces directly rather than wrapped as "construction failed".
      const codexOptions = buildCodexOptions(apiKey);
      let codex: Codex;
      let thread: Thread;
      try {
        codex = new Codex(codexOptions);
        thread = codex.startThread(buildThreadOptions(input));
      } catch (err) {
        throw new AgentRunFailedError("Codex construction failed", { cause: err });
      }

      const state = createSdkRunHandleState({
        cancelRun: () => {
          abortController.abort();
          return Promise.resolve();
        },
        ...(input.signal !== undefined && { signal: input.signal }),
      });

      void this.#runPipeline(thread, input, abortController, state.callbacks);

      return buildSdkRunHandle({
        agentId: input.agentName ?? runId,
        runId,
        state,
      });
    });
  }

  attach(_input: AgentRunAttachInput): Promise<AgentRunHandle> {
    return Promise.reject(
      new OperationNotSupportedError("Codex local runner does not support attach; use run()"),
    );
  }

  async #runPipeline(
    thread: Thread,
    input: AgentRunInput,
    abortController: AbortController,
    callbacks: {
      finalizeOk: (terminal: AgentRunResult) => void;
      detachSignalListener: () => void;
    },
  ): Promise<void> {
    try {
      await consumeEventStream(thread, input, abortController, callbacks);
    } finally {
      callbacks.detachSignalListener();
    }
  }
}

/**
 * `LocalClaudeRunner` — local runtime user of `@anthropic-ai/claude-agent-sdk`.
 * Drives a local Claude agent via `query()`, streams events to `onEvent`,
 * resolves `handle.result` on terminal `result` message.
 */

import type {
  Query,
  McpServerConfig as SdkMcpServerConfig,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@ship/agent-runner";
import type { ModelSelection } from "@ship/workflow";

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentRunFailedError,
  agentRunFailedError,
  buildSdkRunHandle,
  createSdkRunHandleState,
  MissingApiKeyError,
} from "@ship/agent-runner";
import { randomUUID } from "node:crypto";
import { accessSync } from "node:fs";

import type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
} from "./runner.js";

import { assertCredentialSource } from "./credential-source.js";
import {
  OperationNotSupportedError,
  UnsupportedPlatformError,
  WrongRunnerError,
} from "./errors.js";
import { MAX_CLASSIFICATION_EVENTS } from "./terminal-map.js";
import { mapMidStreamFailure, mapResultMessage } from "./terminal-map.js";

const API_KEY_ENV = "ANTHROPIC_API_KEY";
const AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const BASE_URL_ENV = "ANTHROPIC_BASE_URL";

const SUPPORTED_PLATFORM_KEYS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-arm64-musl",
  "linux-x64",
  "linux-x64-musl",
  "win32-arm64",
  "win32-x64",
]);

const PLATFORM_ARCH_SUFFIX: Record<string, Record<string, string>> = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  win32: { arm64: "win32-arm64", x64: "win32-x64" },
};

function isMuslLinux(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report.getReport() as
      | { readonly header?: { readonly glibcVersionRuntime?: string } }
      | undefined;
    if (report?.header?.glibcVersionRuntime !== undefined) return false;
  } catch {
    /* fall through */
  }
  try {
    accessSync("/etc/alpine-release");
    return true;
  } catch {
    return false;
  }
}

function linuxBinarySuffix(arch: string): string | undefined {
  const musl = isMuslLinux();
  if (arch === "arm64") return musl ? "linux-arm64-musl" : "linux-arm64";
  if (arch === "x64") return musl ? "linux-x64-musl" : "linux-x64";
  return undefined;
}

function platformBinarySuffix(): string | undefined {
  const { platform, arch } = process;
  if (platform === "linux") return linuxBinarySuffix(arch);
  return PLATFORM_ARCH_SUFFIX[platform]?.[arch];
}

function assertPlatformSupported(): void {
  const suffix = platformBinarySuffix();
  if (suffix === undefined || !SUPPORTED_PLATFORM_KEYS.has(suffix)) {
    throw new UnsupportedPlatformError(process.platform, process.arch);
  }
}

function fallbackModelFromParams(params: ModelSelection["params"]): string | undefined {
  if (params === undefined) return undefined;
  const fallback = params.find((p) => p.id === "fallbackModel" || p.id === "fallback");
  if (fallback === undefined) return undefined;
  if (typeof fallback.value === "string" && fallback.value.length > 0) return fallback.value;
  return undefined;
}

type QueryEffort = Extract<NonNullable<Parameters<typeof query>[0]["options"]>["effort"], string>;

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies QueryEffort[]);

// The driver records the effort tier as a "reasoning" model param; the SDK
// takes it as the query effort option. An unrecognized value is dropped (the
// SDK default applies) rather than failing the dispatch.
function effortFromParams(params: ModelSelection["params"]): QueryEffort | undefined {
  if (params === undefined) return undefined;
  const reasoning = params.find((p) => p.id === "reasoning");
  if (reasoning === undefined) return undefined;
  if (typeof reasoning.value !== "string" || !EFFORT_LEVELS.has(reasoning.value)) {
    return undefined;
  }
  return reasoning.value as QueryEffort;
}

function translateMcpServers(
  mcpServers: Record<string, McpServerConfig> | undefined,
): Record<string, SdkMcpServerConfig> | undefined {
  if (mcpServers === undefined) return undefined;
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (config.type === "stdio") {
      out[name] = {
        ...(config.args !== undefined && { args: [...config.args] }),
        ...(config.env !== undefined && { env: { ...config.env } }),
        command: config.command,
        type: "stdio",
      };
      continue;
    }
    out[name] = {
      ...(config.headers !== undefined && { headers: { ...config.headers } }),
      type: "http",
      url: config.url,
    };
  }
  return out;
}

function buildQueryEnv(): Record<string, string> {
  const normalizedKeys = new Set([
    API_KEY_ENV,
    AUTH_TOKEN_ENV,
    CLAUDE_CODE_OAUTH_TOKEN_ENV,
    BASE_URL_ENV,
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (!normalizedKeys.has(entry[0]) || entry[1].trim() !== ""),
    ),
  );
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function buildQueryOptions(
  input: AgentRunInput,
  abortController: AbortController,
  sessionId: `${string}-${string}-${string}-${string}-${string}`,
): NonNullable<Parameters<typeof query>[0]["options"]> {
  const fallbackModel = fallbackModelFromParams(input.model.params);
  const effort = effortFromParams(input.model.params);
  return {
    abortController,
    allowDangerouslySkipPermissions: true,
    cwd: input.cwd,
    ...(effort !== undefined && { effort }),
    env: buildQueryEnv(),
    ...(fallbackModel !== undefined && { fallbackModel }),
    ...(input.agents !== undefined && { agents: input.agents }),
    ...(input.mcpServers !== undefined && {
      mcpServers: translateMcpServers(input.mcpServers),
    }),
    model: input.model.id,
    permissionMode: "bypassPermissions",
    sessionId,
  } as NonNullable<Parameters<typeof query>[0]["options"]>;
}

function startQuery(
  input: AgentRunInput,
  abortController: AbortController,
  sessionId: `${string}-${string}-${string}-${string}-${string}`,
): Query {
  try {
    return query({
      options: buildQueryOptions(input, abortController, sessionId),
      prompt: input.prompt,
    });
  } catch (err) {
    throw new AgentRunFailedError("query() construction failed", { cause: err });
  }
}

function validateRunInput(input: AgentRunInput): void {
  if (input.runtime !== undefined && input.runtime !== "local") {
    throw new WrongRunnerError(
      `LocalClaudeRunner accepts runtime: "local" or undefined; received: ${JSON.stringify(input.runtime)}`,
    );
  }
  const apiKey = process.env[API_KEY_ENV];
  const authToken = process.env[AUTH_TOKEN_ENV];
  const claudeCodeOAuthToken = process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV];
  const hasApiKey = apiKey !== undefined && apiKey.trim() !== "";
  const hasAuthToken = authToken !== undefined && authToken.trim() !== "";
  const hasClaudeCodeOAuthToken =
    claudeCodeOAuthToken !== undefined && claudeCodeOAuthToken.trim() !== "";
  if (!hasApiKey && !hasAuthToken && !hasClaudeCodeOAuthToken) {
    throw new MissingApiKeyError(
      "no Claude credential set (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY required)",
    );
  }
}

async function consumeQueryStream(
  queryInstance: Query,
  input: AgentRunInput,
  callbacks: {
    finalizeOk: (terminal: AgentRunResult) => void;
    finalizeError: (err: unknown) => void;
  },
): Promise<void> {
  const capturedEvents: SDKMessage[] = [];
  const recordEvent = (ev: SDKMessage): void => {
    capturedEvents.push(ev);
    if (capturedEvents.length > MAX_CLASSIFICATION_EVENTS) capturedEvents.shift();
  };

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
    // The foreground query emits exactly one terminal `result` message;
    // subagents / background tasks surface as `task_*` and nested `tool_result`
    // blocks, never a top-level `result`. We drain the whole stream and keep the
    // LAST `result` authoritative (rather than finalizing on the first one),
    // mirroring how the cursor runner consumes its full stream before mapping.
    let lastResult: SDKResultMessage | undefined;
    for await (const ev of queryInstance) {
      recordEvent(ev);
      safelyEmit(ev);
      if (ev.type === "result") lastResult = ev;
    }
    if (lastResult !== undefined) {
      callbacks.finalizeOk(mapResultMessage(lastResult, input, capturedEvents));
      return;
    }
    callbacks.finalizeError(
      agentRunFailedError(
        "query() ended without a terminal result message",
        new Error("missing terminal result"),
      ),
    );
  } catch (streamErr) {
    callbacks.finalizeOk(mapMidStreamFailure(streamErr, input, capturedEvents));
  }
}

export class LocalClaudeRunner implements AgentRunner {
  constructor() {
    assertPlatformSupported();
  }

  run(input: AgentRunInput): Promise<AgentRunHandle> {
    return Promise.resolve().then(() => {
      validateRunInput(input);
      // Repo-pinned credential-source guard: refuse before constructing the
      // query env when the required token source is absent or a forbidden
      // override is present.
      assertCredentialSource(input.cwd, process.env);

      const sessionId = randomUUID();
      const runId = randomUUID();
      const abortController = new AbortController();
      const queryInstance = startQuery(input, abortController, sessionId);

      const state = createSdkRunHandleState({
        cancelRun: async () => {
          abortController.abort();
          try {
            await queryInstance.interrupt();
          } catch {
            /* swallow */
          }
        },
        ...(input.signal !== undefined && { signal: input.signal }),
      });

      void this.#runPipeline(queryInstance, input, state.callbacks);

      return buildSdkRunHandle({
        agentId: input.agentName ?? sessionId,
        runId,
        state,
      });
    });
  }

  attach(_input: AgentRunAttachInput): Promise<AgentRunHandle> {
    return Promise.reject(
      new OperationNotSupportedError("Claude local runner does not support attach; use run()"),
    );
  }

  async #runPipeline(
    queryInstance: Query,
    input: AgentRunInput,
    callbacks: {
      finalizeOk: (terminal: AgentRunResult) => void;
      finalizeError: (err: unknown) => void;
      detachSignalListener: () => void;
    },
  ): Promise<void> {
    try {
      await consumeQueryStream(queryInstance, input, callbacks);
    } finally {
      try {
        queryInstance.close();
      } catch {
        /* swallow */
      }
      callbacks.detachSignalListener();
    }
  }
}

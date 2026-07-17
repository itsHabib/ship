/**
 * Tests for `local-runner.ts`. SDK mocked via `vi.mock("@anthropic-ai/claude-agent-sdk")`
 * so tests run without `ANTHROPIC_API_KEY` or network.
 */

import type { Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AgentRunFailedError,
  CredentialSourcePolicyError,
  MissingApiKeyError,
  OperationNotSupportedError,
  WrongRunnerError,
} from "./errors.js";
import { LocalClaudeRunner } from "./local-runner.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

interface MockQueryOpts {
  events?: SDKMessage[];
  streamThrows?: unknown;
  constructionThrows?: unknown;
}

function makeMockQuery(opts: MockQueryOpts): {
  queryInstance: Query;
  closeSpy: ReturnType<typeof vi.fn>;
  interruptSpy: ReturnType<typeof vi.fn>;
} {
  const events = opts.events ?? [];
  const closeSpy = vi.fn();
  const interruptSpy = vi.fn((): Promise<void> => Promise.resolve());

  const queryInstance = {
    close: closeSpy,
    interrupt: interruptSpy,
    // eslint-disable-next-line @typescript-eslint/require-await
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<SDKMessage, void> {
      if (opts.streamThrows !== undefined) throw toError(opts.streamThrows);
      for (const ev of events) {
        yield ev;
      }
    },
  } as unknown as Query;

  return { closeSpy, interruptSpy, queryInstance };
}

const successResult = {
  duration_api_ms: 1,
  duration_ms: 1234,
  is_error: false,
  modelUsage: {},
  num_turns: 1,
  permission_denials: [],
  result: "implementation done",
  session_id: "sess-1",
  stop_reason: "end_turn",
  subtype: "success",
  total_cost_usd: 0,
  type: "result",
  usage: {
    cache_creation: {},
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: "global",
    input_tokens: 1,
    iterations: [],
    output_tokens: 1,
    output_tokens_details: {},
    server_tool_use: {},
  },
  uuid: "00000000-0000-4000-8000-000000000001",
} as unknown as SDKResultMessage;

const evAssistant: SDKMessage = {
  message: { content: [{ text: "working", type: "text" }], role: "assistant" },
  parent_tool_use_id: null,
  session_id: "sess-1",
  type: "assistant",
  uuid: "asst-1",
} as unknown as SDKMessage;

function baseInput(
  overrides: Partial<Parameters<LocalClaudeRunner["run"]>[0]> = {},
): Parameters<LocalClaudeRunner["run"]>[0] {
  return {
    cwd: "/tmp/test-workdir",
    model: { id: "claude-sonnet-4-20250514" },
    onEvent: vi.fn(),
    prompt: "do the thing",
    ...overrides,
  };
}

function firstQueryEnv(): Record<string, string | undefined> {
  const call = vi.mocked(query).mock.calls[0]?.[0] as
    | { options?: { env?: Record<string, string | undefined> } }
    | undefined;
  return call?.options?.env ?? {};
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-abc123");
  vi.mocked(query).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("LocalClaudeRunner — attach", () => {
  test("throws OperationNotSupportedError unconditionally", async () => {
    const runner = new LocalClaudeRunner();
    await expect(
      runner.attach({
        agentId: "sess-1",
        model: { id: "claude-sonnet-4-20250514" },
        onEvent: vi.fn(),
        runId: "run-1",
      }),
    ).rejects.toBeInstanceOf(OperationNotSupportedError);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("LocalClaudeRunner — credential-source guard", () => {
  let repoRoot: string;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), "ship-runner-cred-"));
    repoRoot = join(tmp, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(join(repoRoot, ".."), { force: true, recursive: true });
  });

  function pinPolicy(credentials: unknown): void {
    writeFileSync(join(repoRoot, ".ship.json"), JSON.stringify({ credentials }), "utf8");
  }

  test("refuses dispatch when the pinned token env is absent, before query()", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "personal-key");
    pinPolicy({ claude_token_env: "WORK_ANTHROPIC_TOKEN" });

    const runner = new LocalClaudeRunner();
    await expect(runner.run(baseInput({ cwd: repoRoot }))).rejects.toBeInstanceOf(
      CredentialSourcePolicyError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  test("refuses dispatch when a forbidden env override is present", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "personal-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://personal.example");
    pinPolicy({ forbid_env: ["ANTHROPIC_BASE_URL"] });

    const runner = new LocalClaudeRunner();
    await expect(runner.run(baseInput({ cwd: repoRoot }))).rejects.toThrow(/ANTHROPIC_BASE_URL/);
    expect(query).not.toHaveBeenCalled();
  });

  test("dispatches when the pinned token env is satisfied", async () => {
    // The pinned env is one the SDK actually reads, so it doubles as the
    // credential validateRunInput requires and the source the policy pins.
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "sk-work-123");
    pinPolicy({ claude_token_env: "ANTHROPIC_AUTH_TOKEN" });
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput({ cwd: repoRoot }));
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(query).toHaveBeenCalled();
  });
});

describe("LocalClaudeRunner — runtime selection", () => {
  test.each([["cloud"], ["rooms"], [null]])(
    "throws WrongRunnerError when runtime is %p",
    async (bad) => {
      const runner = new LocalClaudeRunner();
      await expect(
        runner.run(baseInput({ runtime: bad as unknown as "local" })),
      ).rejects.toBeInstanceOf(WrongRunnerError);
      expect(query).not.toHaveBeenCalled();
    },
  );
});

describe("LocalClaudeRunner — env / pre-run errors", () => {
  test("throws MissingApiKeyError when no credential is set", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    const runner = new LocalClaudeRunner();
    await expect(runner.run(baseInput())).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(query).not.toHaveBeenCalled();
  });

  test("throws MissingApiKeyError when every credential is whitespace", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", " ");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "\t");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "\r\n");
    const runner = new LocalClaudeRunner();
    await expect(runner.run(baseInput())).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(query).not.toHaveBeenCalled();
  });

  test("passes validateRunInput with only ANTHROPIC_AUTH_TOKEN", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "bearer-token-xyz");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(query).toHaveBeenCalled();
  });

  test("passes validateRunInput with only CLAUDE_CODE_OAUTH_TOKEN", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token-xyz");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(query).toHaveBeenCalled();
  });

  test("passes validateRunInput with only ANTHROPIC_API_KEY", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-abc123");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(query).toHaveBeenCalled();
  });

  test("query() construction throw → AgentRunFailedError", async () => {
    const sdkErr = new Error("option validation failed");
    vi.mocked(query).mockImplementation(() => {
      throw sdkErr;
    });
    const runner = new LocalClaudeRunner();
    const promise = runner.run(baseInput());
    await expect(promise).rejects.toBeInstanceOf(AgentRunFailedError);
    await expect(promise).rejects.toMatchObject({ cause: sdkErr });
  });
});

describe("LocalClaudeRunner — happy path", () => {
  test("terminal success → succeeded with summary", async () => {
    const { queryInstance } = makeMockQuery({ events: [evAssistant, successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const onEvent = vi.fn();
    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    const result = await handle.result;

    expect(result).toMatchObject({
      branches: [],
      durationMs: 1234,
      status: "succeeded",
      summary: "implementation done",
    });
    expect(onEvent.mock.calls.map((c) => (c as [SDKMessage])[0])).toEqual([
      evAssistant,
      successResult,
    ]);
  });

  test("error subtype → failed resolves (does not throw)", async () => {
    const errorResult = {
      ...successResult,
      errors: ["budget exceeded"],
      subtype: "error_max_budget_usd",
    } as unknown as SDKResultMessage;
    const { queryInstance } = makeMockQuery({ events: [errorResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("budget-exceeded");
    expect(result.errorMessage).toContain("budget exceeded");
  });
});

describe("LocalClaudeRunner — mid-stream throw", () => {
  test("stream throw without terminal result → failed gateway-unreachable", async () => {
    const streamErr = new Error("fetch failed");
    const { queryInstance } = makeMockQuery({ streamThrows: streamErr });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("gateway-unreachable");
    expect(result.errorMessage).toBe("fetch failed");
  });
});

describe("LocalClaudeRunner — query options", () => {
  test("passes permission bypass, env merge, model, cwd, mcpServers, agents", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.local");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(
      baseInput({
        agents: { "code-reviewer": { description: "d", prompt: "p" } },
        cwd: "/abs/work",
        mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } },
        model: {
          id: "claude-sonnet-4-20250514",
          params: [{ id: "fallbackModel", value: "claude-haiku" }],
        },
      }),
    );

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowDangerouslySkipPermissions: true,
          cwd: "/abs/work",
          env: expect.objectContaining({
            ANTHROPIC_API_KEY: "test-key-abc123",
            ANTHROPIC_BASE_URL: "https://gateway.local",
            PATH: process.env["PATH"],
          }) as Record<string, string | undefined>,
          fallbackModel: "claude-haiku",
          mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } },
          model: "claude-sonnet-4-20250514",
          permissionMode: "bypassPermissions",
        }) as NonNullable<Parameters<typeof query>[0]["options"]>,
        prompt: "do the thing",
      }),
    );
  });

  test("PATH sentinel from process.env reaches options.env (replace-merge)", async () => {
    vi.stubEnv("SHIP_PATH_SENTINEL", "present-in-child-env");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(baseInput());

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: { env?: Record<string, string | undefined> } }
      | undefined;
    expect(call?.options?.env?.["SHIP_PATH_SENTINEL"]).toBe("present-in-child-env");
  });

  test("stdio mcp translation passes command-only config", async () => {
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(
      baseInput({
        mcpServers: {
          docs: {
            args: ["server.js"],
            command: "node",
            env: { FOO: "bar" },
            type: "stdio",
          },
          remote: {
            headers: { Authorization: "Bearer x" },
            type: "http",
            url: "https://example.com",
          },
        },
      }),
    );

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: { mcpServers?: Record<string, unknown> } }
      | undefined;
    expect(call?.options?.mcpServers).toEqual({
      docs: { args: ["server.js"], command: "node", env: { FOO: "bar" }, type: "stdio" },
      remote: { headers: { Authorization: "Bearer x" }, type: "http", url: "https://example.com" },
    });
  });

  test("boolean fallback param is omitted from query options", async () => {
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(
      baseInput({
        model: {
          id: "claude-sonnet-4-20250514",
          params: [{ id: "fallbackModel", value: true }],
        },
      }),
    );

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: Record<string, unknown> }
      | undefined;
    expect(call?.options?.["fallbackModel"]).toBeUndefined();
  });

  test("reasoning param reaches options.effort", async () => {
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(
      baseInput({
        model: {
          id: "claude-opus-4-8",
          params: [{ id: "reasoning", value: "xhigh" }],
        },
      }),
    );

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: Record<string, unknown> }
      | undefined;
    expect(call?.options?.["effort"]).toBe("xhigh");
  });

  test("unrecognized reasoning value is dropped, not dispatched", async () => {
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(
      baseInput({
        model: {
          id: "claude-opus-4-8",
          params: [{ id: "reasoning", value: "turbo" }],
        },
      }),
    );

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: Record<string, unknown> }
      | undefined;
    expect(call?.options?.["effort"]).toBeUndefined();
  });

  test("omits ANTHROPIC_BASE_URL from env when unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-abc123");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(baseInput());

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: { env?: Record<string, string | undefined> } }
      | undefined;
    expect(call?.options?.env?.["ANTHROPIC_API_KEY"]).toBe("test-key-abc123");
    expect(call?.options?.env?.["ANTHROPIC_BASE_URL"]).toBeUndefined();
  });

  test("forwards ANTHROPIC_AUTH_TOKEN when set", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "bearer-token-xyz");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(baseInput());

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: { env?: Record<string, string | undefined> } }
      | undefined;
    expect(call?.options?.env?.["ANTHROPIC_AUTH_TOKEN"]).toBe("bearer-token-xyz");
  });

  test("forwards CLAUDE_CODE_OAUTH_TOKEN when set", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token-xyz");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(baseInput());

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: { env?: Record<string, string | undefined> } }
      | undefined;
    expect(call?.options?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-token-xyz");
  });

  test("omits whitespace-only tokens when another credential is valid", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-abc123");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", " ");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "\t");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(baseInput());

    const env = firstQueryEnv();
    expect(env["ANTHROPIC_API_KEY"]).toBe("test-key-abc123");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
  });

  test("omits ANTHROPIC_AUTH_TOKEN from env when unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-abc123");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(baseInput());

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: { env?: Record<string, string | undefined> } }
      | undefined;
    expect(call?.options?.env?.["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  });

  test("omits CLAUDE_CODE_OAUTH_TOKEN from env when unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-abc123");
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    await runner.run(baseInput());

    const call = vi.mocked(query).mock.calls[0]?.[0] as
      | { options?: { env?: Record<string, string | undefined> } }
      | undefined;
    expect(call?.options?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
  });

  test("interrupt rejection during cancel is swallowed", async () => {
    const { interruptSpy, queryInstance } = makeMockQuery({ events: [successResult] });
    interruptSpy.mockRejectedValueOnce(new Error("interrupt failed"));
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.cancel()).resolves.toBeUndefined();
    await handle.result;
  });

  test("close rejection during cleanup is swallowed", async () => {
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.spyOn(queryInstance, "close").mockImplementation(() => {
      throw new Error("close failed");
    });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
  });

  test("unsupported linux arch throws UnsupportedPlatformError", () => {
    const arch = process.arch;
    Object.defineProperty(process, "arch", { value: "ia32" });
    try {
      expect(() => new LocalClaudeRunner()).toThrow(/unsupported on this host/i);
    } finally {
      Object.defineProperty(process, "arch", { value: arch });
    }
  });
});

describe("LocalClaudeRunner — cancellation", () => {
  test("AbortSignal pre-aborted → interrupt invoked", async () => {
    const { interruptSpy, queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const controller = new AbortController();
    controller.abort();
    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    await handle.result;
    expect(interruptSpy).toHaveBeenCalledTimes(1);
  });
});

describe("LocalClaudeRunner — platform guard", () => {
  test("throws UnsupportedPlatformError on unknown platform", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "freebsd" });
    try {
      expect(() => new LocalClaudeRunner()).toThrow(/unsupported on this host/i);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });
});

describe("LocalClaudeRunner — stream termination", () => {
  test("clean stream without terminal result rejects handle.result", async () => {
    const { queryInstance } = makeMockQuery({ events: [evAssistant] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).rejects.toThrow(/without a terminal result/);
  });
});

describe("LocalClaudeRunner — failure subtypes", () => {
  test("error_during_execution maps logic when tool_result errored", async () => {
    const toolErr = {
      message: {
        content: [
          {
            content: "make check failed",
            is_error: true,
            tool_use_id: "tu-1",
            type: "tool_result",
          },
        ],
      },
      type: "user",
    } as unknown as SDKMessage;
    const errorResult = {
      ...successResult,
      errors: [],
      subtype: "error_during_execution",
    } as unknown as SDKResultMessage;
    const { queryInstance } = makeMockQuery({ events: [toolErr, errorResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("logic");
  });

  test("error_max_structured_output_retries → logic category", async () => {
    const errorResult = {
      ...successResult,
      errors: ["schema mismatch"],
      subtype: "error_max_structured_output_retries",
    } as unknown as SDKResultMessage;
    const { queryInstance } = makeMockQuery({ events: [errorResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.failureCategory).toBe("logic");
  });
});

describe("LocalClaudeRunner — onEvent contract", () => {
  test("onEvent throws are swallowed", async () => {
    const { queryInstance } = makeMockQuery({ events: [evAssistant, successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const onEvent = vi.fn().mockImplementation(() => {
      throw new Error("consumer broken");
    });
    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  test("async onEvent rejection is swallowed", async () => {
    const { queryInstance } = makeMockQuery({ events: [evAssistant, successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const onEvent = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error("async consumer broke")));
    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});

describe("LocalClaudeRunner — handle shape", () => {
  test("handle exposes agentId and runId", async () => {
    const { queryInstance } = makeMockQuery({ events: [successResult] });
    vi.mocked(query).mockReturnValue(queryInstance);

    const runner = new LocalClaudeRunner();
    const handle = await runner.run(baseInput({ agentName: "ship/wf-123" }));
    expect(handle.agentId).toBe("ship/wf-123");
    expect(handle.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    await handle.result;
  });
});

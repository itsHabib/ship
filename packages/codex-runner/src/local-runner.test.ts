/**
 * Tests for `local-runner.ts`. SDK mocked via `vi.mock("@openai/codex-sdk")`
 * so tests run without `CODEX_API_KEY` or network.
 */

import type { Thread, ThreadEvent } from "@openai/codex-sdk";

import { Codex } from "@openai/codex-sdk";
import { FakeAgentRunner } from "@ship/agent-runner/test/fake";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AgentRunFailedError,
  MissingApiKeyError,
  OperationNotSupportedError,
  WrongRunnerError,
} from "./errors.js";
import { CodexRunner } from "./local-runner.js";

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn(),
}));

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

interface MockStreamOpts {
  events?: ThreadEvent[];
  streamThrows?: unknown;
}

function makeMockThread(opts: MockStreamOpts): Thread {
  const events = opts.events ?? [];
  return {
    id: null,
    run: vi.fn(),
    runStreamed: vi.fn(() =>
      Promise.resolve({
        events: (function* (): Generator<ThreadEvent, void> {
          if (opts.streamThrows !== undefined) throw toError(opts.streamThrows);
          for (const ev of events) {
            yield ev;
          }
        })(),
      }),
    ),
  } as unknown as Thread;
}

const turnCompleted = {
  type: "turn.completed",
  usage: {
    cached_input_tokens: 0,
    input_tokens: 1,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  },
} as ThreadEvent;

const agentMessageDone = {
  item: { id: "msg-1", text: "implementation done", type: "agent_message" },
  type: "item.completed",
} as ThreadEvent;

function makeMockCodex(thread: Thread): Codex {
  return { startThread: () => thread } as unknown as Codex;
}

function baseInput(
  overrides: Partial<Parameters<CodexRunner["run"]>[0]> = {},
): Parameters<CodexRunner["run"]>[0] {
  return {
    cwd: "/tmp/test-workdir",
    model: { id: "gpt-5.3-codex" },
    onEvent: vi.fn(),
    prompt: "do the thing",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("CODEX_API_KEY", "test-key-abc123");
  vi.mocked(Codex).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CodexRunner — attach", () => {
  test("throws OperationNotSupportedError unconditionally", async () => {
    const runner = new CodexRunner();
    await expect(
      runner.attach({
        agentId: "thread-1",
        model: { id: "gpt-5.3-codex" },
        onEvent: vi.fn(),
        runId: "run-1",
      }),
    ).rejects.toBeInstanceOf(OperationNotSupportedError);
    expect(Codex).not.toHaveBeenCalled();
  });
});

describe("CodexRunner — runtime selection", () => {
  test.each([["cloud"], ["rooms"], [null]])(
    "throws WrongRunnerError when runtime is %p",
    async (bad) => {
      const runner = new CodexRunner();
      await expect(
        runner.run(baseInput({ runtime: bad as unknown as "local" })),
      ).rejects.toBeInstanceOf(WrongRunnerError);
      expect(Codex).not.toHaveBeenCalled();
    },
  );
});

describe("CodexRunner — env / pre-run errors", () => {
  test("throws MissingApiKeyError when both API key env vars are unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const runner = new CodexRunner();
    await expect(runner.run(baseInput())).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(Codex).not.toHaveBeenCalled();
  });

  test("falls back to OPENAI_API_KEY", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));
    const runner = new CodexRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(Codex).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "openai-key" }));
  });

  test("Codex construction throw → AgentRunFailedError", async () => {
    const sdkErr = new Error("option validation failed");
    vi.mocked(Codex).mockImplementation(() => {
      throw sdkErr;
    });
    const runner = new CodexRunner();
    const promise = runner.run(baseInput());
    await expect(promise).rejects.toBeInstanceOf(AgentRunFailedError);
    await expect(promise).rejects.toMatchObject({ cause: sdkErr });
  });
});

describe("CodexRunner — happy path", () => {
  test("terminal turn.completed → succeeded with summary", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const onEvent = vi.fn();
    const runner = new CodexRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    const result = await handle.result;

    expect(result).toMatchObject({
      branches: [],
      status: "succeeded",
      summary: "implementation done",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(onEvent.mock.calls.map((c) => (c as [ThreadEvent])[0])).toEqual([
      agentMessageDone,
      turnCompleted,
    ]);
  });

  test("turn.failed → failed resolves (does not throw)", async () => {
    const turnFailed = {
      error: { message: "agent crashed" },
      type: "turn.failed",
    } as ThreadEvent;
    const thread = makeMockThread({ events: [turnFailed] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("agent crashed");
  });
});

describe("CodexRunner — mid-stream throw", () => {
  test("stream throw without terminal result → failed gateway-unreachable", async () => {
    const thread = makeMockThread({ streamThrows: new Error("fetch failed") });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("gateway-unreachable");
    expect(result.errorMessage).toBe("fetch failed");
  });
});

describe("CodexRunner — SDK options", () => {
  test("passes sandbox, cwd, model, gateway env, and process.env spread", async () => {
    vi.stubEnv("CODEX_BASE_URL", "https://gateway.local");
    vi.stubEnv("CODEX_MODEL_PROVIDER", "custom");
    vi.stubEnv("CODEX_MODEL_PROVIDER_BASE_URL", "https://custom.local/v1");
    vi.stubEnv("CODEX_MODEL_PROVIDER_ENV_KEY", "CUSTOM_API_KEY");
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    const startThread = vi.fn((_opts?: unknown) => thread);
    vi.mocked(Codex).mockImplementation(() => ({ startThread }) as unknown as Codex);

    const runner = new CodexRunner();
    await runner.run(baseInput({ cwd: "/abs/work", model: { id: "gpt-5.3-codex" } }));

    expect(Codex).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key-abc123",
        baseUrl: "https://gateway.local",
        config: {
          model_provider: "custom",
          model_providers: {
            custom: {
              base_url: "https://custom.local/v1",
              env_key: "CUSTOM_API_KEY",
              wire_api: "responses",
            },
          },
        },
        env: expect.objectContaining({
          CODEX_API_KEY: "test-key-abc123",
          CODEX_BASE_URL: "https://gateway.local",
          PATH: process.env["PATH"],
        }) as Record<string, string | undefined>,
      }),
    );
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "never",
        model: "gpt-5.3-codex",
        skipGitRepoCheck: false,
        workingDirectory: "/abs/work",
      }),
    );
    expect(thread.runStreamed).toHaveBeenCalledWith(
      "do the thing",
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    );
  });

  test("PATH sentinel from process.env reaches Codex env (replace-merge)", async () => {
    vi.stubEnv("SHIP_PATH_SENTINEL", "present-in-child-env");
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    await runner.run(baseInput());

    const call = vi.mocked(Codex).mock.calls[0]![0] as { env?: Record<string, string | undefined> };
    expect(call.env?.["SHIP_PATH_SENTINEL"]).toBe("present-in-child-env");
    expect(process.env["SHIP_PATH_SENTINEL"]).toBe("present-in-child-env");
  });

  test("does not mutate process.env globally when building Codex options", async () => {
    const before = { ...process.env };
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));
    const runner = new CodexRunner();
    await runner.run(baseInput());
    expect(process.env).toEqual(before);
  });

  test("mcpServers and agents are not passed to the SDK", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    const startThread = vi.fn((_opts?: unknown) => thread);
    vi.mocked(Codex).mockImplementation(() => ({ startThread }) as unknown as Codex);

    const runner = new CodexRunner();
    await runner.run(
      baseInput({
        agents: { reviewer: { description: "d", prompt: "p" } },
        mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } },
      }),
    );

    expect(startThread).toHaveBeenCalledOnce();
    const threadArgs = startThread.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(threadArgs?.["mcpServers"]).toBeUndefined();
    expect(threadArgs?.["agents"]).toBeUndefined();
  });

  test("partial gateway config (missing one of three vars) → AgentRunFailedError", async () => {
    vi.stubEnv("CODEX_MODEL_PROVIDER", "custom");
    vi.stubEnv("CODEX_MODEL_PROVIDER_BASE_URL", "https://custom.local/v1");
    // CODEX_MODEL_PROVIDER_ENV_KEY intentionally left unset — partial config must
    // fail loudly rather than silently running against the default endpoint.
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    const promise = runner.run(baseInput());
    await expect(promise).rejects.toBeInstanceOf(AgentRunFailedError);
    await expect(promise).rejects.toThrow(/CODEX_MODEL_PROVIDER_ENV_KEY/);
    expect(Codex).not.toHaveBeenCalled();
  });

  test("no gateway config vars → no config passed", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    await runner.run(baseInput());
    const opts = vi.mocked(Codex).mock.calls[0]![0] as { config?: unknown };
    expect(opts.config).toBeUndefined();
  });
});

describe("CodexRunner — cancellation", () => {
  test("AbortSignal pre-aborted → runStreamed still invoked with aborted signal", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const controller = new AbortController();
    controller.abort();
    const runner = new CodexRunner();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    await handle.result;
    const runStreamedCall = vi.mocked(thread.runStreamed).mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(runStreamedCall?.signal?.aborted).toBe(true);
  });

  test("aborted run resolves cancelled, not the terminal turn result", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const controller = new AbortController();
    controller.abort();
    const runner = new CodexRunner();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    const result = await handle.result;
    // A cancel must not be recorded as a failure or a (stale) success.
    expect(result.status).toBe("cancelled");
    expect(result.branches).toEqual([]);
  });

  test("abort that surfaces as a stream throw still resolves cancelled", async () => {
    const thread = makeMockThread({
      streamThrows: new Error("AbortError: the operation was aborted"),
    });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const controller = new AbortController();
    controller.abort();
    const runner = new CodexRunner();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
  });
});

describe("CodexRunner — sandbox mode by platform", () => {
  async function sandboxModeFor(platform: string, optIn: boolean): Promise<unknown> {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: platform });
    vi.stubEnv("SHIP_CODEX_WIN32_FULL_ACCESS", optIn ? "1" : "");
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    const startThread = vi.fn((_opts?: unknown) => thread);
    vi.mocked(Codex).mockImplementation(() => ({ startThread }) as unknown as Codex);
    try {
      await new CodexRunner().run(baseInput());
      const opts = startThread.mock.calls[0]?.[0] as { sandboxMode?: unknown } | undefined;
      return opts?.sandboxMode;
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  }

  test("win32 with SHIP_CODEX_WIN32_FULL_ACCESS=1 opt-in uses danger-full-access", async () => {
    expect(await sandboxModeFor("win32", true)).toBe("danger-full-access");
  });

  test("win32 without opt-in keeps workspace-write (sandbox not silently dropped)", async () => {
    expect(await sandboxModeFor("win32", false)).toBe("workspace-write");
  });

  test("posix uses workspace-write regardless of opt-in", async () => {
    expect(await sandboxModeFor("linux", true)).toBe("workspace-write");
  });
});

describe("CodexRunner — platform guard", () => {
  test("throws UnsupportedPlatformError on unknown platform", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "freebsd" });
    try {
      expect(() => new CodexRunner()).toThrow(/unsupported on this host/i);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  test("unsupported arch throws UnsupportedPlatformError", () => {
    const arch = process.arch;
    Object.defineProperty(process, "arch", { value: "ia32" });
    try {
      expect(() => new CodexRunner()).toThrow(/unsupported on this host/i);
    } finally {
      Object.defineProperty(process, "arch", { value: arch });
    }
  });
});

describe("CodexRunner — stream termination", () => {
  test("clean stream without terminal turn resolves failed", async () => {
    const thread = makeMockThread({ events: [agentMessageDone] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("without a terminal turn event");
  });
});

describe("CodexRunner — failure categories", () => {
  test("sandbox-denial from failed command output", async () => {
    const sandboxFail = {
      item: {
        aggregated_output: "not permitted in the sandbox",
        command: "curl evil",
        id: "cmd-1",
        status: "failed",
        type: "command_execution",
      },
      type: "item.completed",
    } as ThreadEvent;
    const turnFailed = { error: { message: "turn failed" }, type: "turn.failed" } as ThreadEvent;
    const thread = makeMockThread({ events: [sandboxFail, turnFailed] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.failureCategory).toBe("sandbox-denial");
  });

  test("patch-apply-fail from failed file_change", async () => {
    const patchFail = {
      item: {
        changes: [{ kind: "update", path: "a.ts" }],
        id: "fc-1",
        status: "failed",
        type: "file_change",
      },
      type: "item.completed",
    } as ThreadEvent;
    const turnFailed = { error: { message: "turn failed" }, type: "turn.failed" } as ThreadEvent;
    const thread = makeMockThread({ events: [patchFail, turnFailed] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.failureCategory).toBe("patch-apply-fail");
  });
});

describe("CodexRunner — onEvent contract", () => {
  test("onEvent throws are swallowed", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const onEvent = vi.fn().mockImplementation(() => {
      throw new Error("consumer broken");
    });
    const runner = new CodexRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  test("async onEvent rejection is swallowed", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const onEvent = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error("async consumer broke")));
    const runner = new CodexRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  test("omits model when model id is empty", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    const startThread = vi.fn((_opts?: unknown) => thread);
    vi.mocked(Codex).mockImplementation(() => ({ startThread }) as unknown as Codex);

    const runner = new CodexRunner();
    await runner.run(baseInput({ model: { id: "" } }));
    expect(startThread).toHaveBeenCalledWith(
      expect.not.objectContaining({ model: expect.anything() as string }),
    );
  });

  test("uses OPENAI_BASE_URL when CODEX_BASE_URL is unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CODEX_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://openai-base.local");
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    await runner.run(baseInput());
    expect(Codex).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://openai-base.local" }),
    );
  });
});

describe("CodexRunner — handle shape", () => {
  test("handle exposes agentId and runId", async () => {
    const thread = makeMockThread({ events: [agentMessageDone, turnCompleted] });
    vi.mocked(Codex).mockImplementation(() => makeMockCodex(thread));

    const runner = new CodexRunner();
    const handle = await runner.run(baseInput({ agentName: "ship/wf-123" }));
    expect(handle.agentId).toBe("ship/wf-123");
    expect(handle.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    await handle.result;
  });
});

describe("CodexRunner — L3 dispatch parity", () => {
  test("provider codex local dispatch via FakeAgentRunner succeeds end-to-end", async () => {
    const fake = new FakeAgentRunner({
      defaultScript: {
        events: [],
        result: {
          branches: [],
          durationMs: 42,
          status: "succeeded",
          summary: "fake codex done",
        },
      },
    });
    const handle = await fake.run({
      cwd: "/tmp",
      model: { id: "gpt-5.3-codex" },
      onEvent: vi.fn(),
      prompt: "ship it",
      runtime: "local",
    });
    const result = await handle.result;
    expect(result).toMatchObject({ status: "succeeded", summary: "fake codex done" });
  });
});

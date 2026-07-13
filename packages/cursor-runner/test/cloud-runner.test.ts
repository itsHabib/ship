/**
 * Tests for `cloud-runner.ts`. SDK mocked via `vi.mock("@cursor/sdk")`.
 */

import type { AgentOptions, Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";

import {
  Agent,
  CursorSdkError,
  IntegrationNotConnectedError,
  UnknownAgentError,
} from "@cursor/sdk";
import { createLogger } from "@ship/logger";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentRunInput, CloudRunSpec } from "../src/runner.js";

import { mapTerminalResult } from "../src/_shared.js";
import { LIST_ARTIFACTS_TIMEOUT_MS } from "../src/artifacts-capture.js";
import { CloudCursorRunner } from "../src/cloud-runner.js";
import {
  AgentRunFailedError,
  CursorAgentNotFoundError,
  CursorCloudIntegrationError,
  InvalidCloudReposError,
  MissingApiKeyError,
  MissingCloudSpecError,
  WrongRunnerError,
} from "../src/errors.js";

vi.mock("@cursor/sdk", () => {
  class CursorSdkErrorMock extends Error {
    readonly status: number | undefined;

    constructor(message: string, opts?: { status?: number }) {
      super(message);
      this.status = opts?.status;
    }
  }

  class UnknownAgentErrorMock extends CursorSdkErrorMock {
    override readonly name = "UnknownAgentError";
  }

  class IntegrationNotConnectedErrorMock extends Error {
    readonly helpUrl: string;
    readonly provider: string;

    constructor(message: string, opts: { helpUrl: string; provider: string }) {
      super(message);
      this.provider = opts.provider;
      this.helpUrl = opts.helpUrl;
    }
  }

  return {
    Agent: {
      create: vi.fn(),
      getRun: vi.fn(),
      resume: vi.fn(),
    },
    CursorSdkError: CursorSdkErrorMock,
    IntegrationNotConnectedError: IntegrationNotConnectedErrorMock,
    UnknownAgentError: UnknownAgentErrorMock,
  };
});

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type MockRun = Run;
type MockAgent = SDKAgent;

interface MockRunOpts {
  events?: SDKMessage[];
  result?: RunResult;
  streamThrows?: unknown;
  waitThrows?: unknown;
  cancelThrows?: unknown;
  runId?: string;
}

function makeMockRun(opts: MockRunOpts & { status?: Run["status"] }): {
  run: MockRun;
  cancelSpy: ReturnType<typeof vi.fn>;
  waitSpy: ReturnType<typeof vi.fn>;
  streamSpy: ReturnType<typeof vi.fn>;
} {
  const events = opts.events ?? [];
  const runId = opts.runId ?? "run-test-cloud-0001";
  const result: RunResult = opts.result ?? {
    durationMs: 1234,
    id: runId,
    result: "scripted summary",
    status: "finished",
  };

  const cancelSpy = vi.fn((): Promise<void> => {
    if (opts.cancelThrows !== undefined) return Promise.reject(toError(opts.cancelThrows));
    return Promise.resolve();
  });
  const waitSpy = vi.fn((): Promise<RunResult> => {
    if (opts.waitThrows !== undefined) return Promise.reject(toError(opts.waitThrows));
    return Promise.resolve(result);
  });
  // eslint-disable-next-line @typescript-eslint/require-await
  const streamSpy = vi.fn(async function* (): AsyncGenerator<SDKMessage, void> {
    if (opts.streamThrows !== undefined) throw toError(opts.streamThrows);
    for (const ev of events) {
      yield ev;
    }
  });

  const run: MockRun = {
    agentId: "agent-test-cloud-0001",
    cancel: cancelSpy,
    conversation: vi.fn(),
    id: runId,
    onDidChangeStatus: vi.fn(() => () => {
      /* noop unsubscribe */
    }),
    status: opts.status ?? "running",
    stream: streamSpy,
    supports: vi.fn(() => true),
    unsupportedReason: vi.fn(() => undefined),
    wait: waitSpy,
  };

  return { cancelSpy, run, streamSpy, waitSpy };
}

function makeMockAgent(opts: { run: MockRun; sendThrows?: unknown; agentId?: string }): {
  agent: MockAgent;
  disposeSpy: ReturnType<typeof vi.fn>;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const disposeSpy = vi.fn((): Promise<void> => Promise.resolve());
  const sendSpy = vi.fn((): Promise<Run> => {
    if (opts.sendThrows !== undefined) return Promise.reject(toError(opts.sendThrows));
    return Promise.resolve(opts.run);
  });
  const agent: MockAgent = {
    [Symbol.asyncDispose]: disposeSpy,
    agentId: opts.agentId ?? "agent-test-cloud-0001",
    close: vi.fn(),
    downloadArtifact: vi.fn(),
    listArtifacts: vi.fn().mockResolvedValue([]),
    model: undefined,
    reload: vi.fn(),
    send: sendSpy,
  };
  return { agent, disposeSpy, sendSpy };
}

const evA: SDKMessage = {
  agent_id: "agent-test-cloud-0001",
  message: { content: [{ text: "first", type: "text" }], role: "assistant" },
  run_id: "run-test-cloud-0001",
  type: "assistant",
} as unknown as SDKMessage;

const evB: SDKMessage = {
  agent_id: "agent-test-cloud-0001",
  message: { content: [{ text: "second", type: "text" }], role: "assistant" },
  run_id: "run-test-cloud-0001",
  type: "assistant",
} as unknown as SDKMessage;

function cloudTestLogger(): ReturnType<typeof createLogger> {
  return createLogger({ level: "debug", stream: process.stderr });
}

function cloudBaseInput(
  overrides: Partial<Parameters<CloudCursorRunner["run"]>[0]> = {},
): Parameters<CloudCursorRunner["run"]>[0] {
  return {
    cloud: {
      repos: [{ url: "https://github.com/acme/sandbox" }],
    },
    cwd: "/tmp/cloud-unused-cwd",
    model: { id: "composer-2.5" },
    onEvent: vi.fn(),
    prompt: "do the cloud thing",
    runtime: "cloud",
    ...overrides,
    log: overrides.log ?? cloudTestLogger(),
  };
}

beforeEach(() => {
  vi.stubEnv("CURSOR_API_KEY", "test-key-cloud");
  vi.mocked(Agent.create).mockReset();
  vi.mocked(Agent.resume).mockReset();
  vi.mocked(Agent.getRun).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function cloudAttachBaseInput(
  overrides: Partial<Parameters<CloudCursorRunner["attach"]>[0]> = {},
): Parameters<CloudCursorRunner["attach"]>[0] {
  return {
    agentId: "bc-test-cloud-0001",
    cloud: {
      repos: [{ url: "https://github.com/acme/sandbox" }],
    },
    model: { id: "composer-2.5" },
    onEvent: vi.fn(),
    runId: "run-test-cloud-0001",
    ...overrides,
  };
}

describe("CloudCursorRunner — attach", () => {
  test("happy path: resume + getRun streams events and resolves terminal result", async () => {
    const { run } = makeMockRun({
      events: [evA, evB],
      result: {
        durationMs: 42_000,
        id: "run-test-cloud-0001",
        result: "attached run finished",
        status: "finished",
      },
      runId: "run-test-cloud-0001",
    });
    const { agent, disposeSpy } = makeMockAgent({
      agentId: "bc-test-cloud-0001",
      run,
    });
    vi.mocked(Agent.resume).mockResolvedValue(agent);
    vi.mocked(Agent.getRun).mockResolvedValue(run);

    const onEvent = vi.fn();
    const runner = new CloudCursorRunner();
    const handle = await runner.attach(cloudAttachBaseInput({ onEvent }));
    const result = await handle.result;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(Agent.resume).toHaveBeenCalledWith("bc-test-cloud-0001", {
      apiKey: "test-key-cloud",
      model: { id: "composer-2.5" },
    });
    expect(Agent.getRun).toHaveBeenCalledWith("run-test-cloud-0001", {
      agentId: "bc-test-cloud-0001",
      apiKey: "test-key-cloud",
      runtime: "cloud",
    });
    expect(handle.agentId).toBe("bc-test-cloud-0001");
    expect(handle.runId).toBe("run-test-cloud-0001");
    expect(result).toMatchObject({
      durationMs: 42_000,
      status: "succeeded",
      summary: "attached run finished",
    });
    const emitted = onEvent.mock.calls.map((c) => (c as [SDKMessage])[0]);
    expect(emitted[0]).toMatchObject({
      type: "ship.resumed",
      agentId: "bc-test-cloud-0001",
      runId: "run-test-cloud-0001",
    });
    expect(typeof (emitted[0] as { ts?: string }).ts).toBe("string");
    expect(emitted.slice(1)).toEqual([evA, evB]);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("Agent.resume UnknownAgentError → CursorAgentNotFoundError", async () => {
    const sdkErr = new UnknownAgentError("agent gone");
    vi.mocked(Agent.resume).mockRejectedValue(sdkErr);

    const runner = new CloudCursorRunner();
    const input = cloudAttachBaseInput();
    const promise = runner.attach(input);
    await expect(promise).rejects.toBeInstanceOf(CursorAgentNotFoundError);
    await expect(promise).rejects.toMatchObject({
      agentId: "bc-test-cloud-0001",
      runId: "run-test-cloud-0001",
      runtime: "cloud",
      cause: sdkErr,
    });
    expect(Agent.getRun).not.toHaveBeenCalled();
  });

  test("Agent.getRun HTTP 404 → CursorAgentNotFoundError; agent disposed", async () => {
    const { agent, disposeSpy } = makeMockAgent({
      agentId: "bc-test-cloud-0001",
      run: makeMockRun({ runId: "run-test-cloud-0001" }).run,
    });
    const sdkErr = new CursorSdkError("run not found", { status: 404 });
    vi.mocked(Agent.resume).mockResolvedValue(agent);
    vi.mocked(Agent.getRun).mockRejectedValue(sdkErr);

    const runner = new CloudCursorRunner();
    const promise = runner.attach(cloudAttachBaseInput());
    await expect(promise).rejects.toBeInstanceOf(CursorAgentNotFoundError);
    await expect(promise).rejects.toMatchObject({
      agentId: "bc-test-cloud-0001",
      runId: "run-test-cloud-0001",
      runtime: "cloud",
      cause: sdkErr,
    });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("Agent.getRun HTTP 410 → CursorAgentNotFoundError", async () => {
    const { agent, disposeSpy } = makeMockAgent({
      agentId: "bc-test-cloud-0001",
      run: makeMockRun({ runId: "run-test-cloud-0001" }).run,
    });
    const sdkErr = new CursorSdkError("run expired", { status: 410 });
    vi.mocked(Agent.resume).mockResolvedValue(agent);
    vi.mocked(Agent.getRun).mockRejectedValue(sdkErr);

    const runner = new CloudCursorRunner();
    await expect(runner.attach(cloudAttachBaseInput())).rejects.toMatchObject({
      runtime: "cloud",
      cause: sdkErr,
    });
    // Mirror the 404 test: when Agent.getRun rejects after Agent.resume
    // succeeds, the resumed agent must be disposed on the way out.
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("throws MissingCloudSpecError when cloud is undefined", async () => {
    const runner = new CloudCursorRunner();
    await expect(
      runner.attach({
        agentId: "bc-test-cloud-0001",
        model: { id: "composer-2.5" },
        onEvent: vi.fn(),
        runId: "run-test-cloud-0001",
      }),
    ).rejects.toBeInstanceOf(MissingCloudSpecError);
    expect(Agent.resume).not.toHaveBeenCalled();
  });

  test("throws InvalidCloudReposError when cloud.repos is empty", async () => {
    const runner = new CloudCursorRunner();
    await expect(
      runner.attach(
        cloudAttachBaseInput({
          cloud: { repos: [] } as unknown as CloudRunSpec,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCloudReposError);
    expect(Agent.resume).not.toHaveBeenCalled();
  });

  test("throws MissingApiKeyError when CURSOR_API_KEY is unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CURSOR_API_KEY", "");
    const runner = new CloudCursorRunner();
    await expect(runner.attach(cloudAttachBaseInput())).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(Agent.resume).not.toHaveBeenCalled();
  });
});

describe("CloudCursorRunner — refreshRun (non-streaming)", () => {
  test("terminal run: resume + getRun + wait maps a terminal result; stream never opened", async () => {
    const { run, streamSpy, cancelSpy, disposeAndAgent } = buildRefreshMock({
      result: {
        durationMs: 7000,
        id: "run-test-cloud-0001",
        result: "finished cloud-side",
        status: "finished",
      },
      status: "finished",
    });
    vi.mocked(Agent.resume).mockResolvedValue(disposeAndAgent.agent);
    vi.mocked(Agent.getRun).mockResolvedValue(run);

    const runner = new CloudCursorRunner();
    const result = await runner.refreshRun({
      agentId: "bc-test-cloud-0001",
      runId: "run-test-cloud-0001",
    });

    expect(result).toMatchObject({
      durationMs: 7000,
      status: "succeeded",
      summary: "finished cloud-side",
    });
    // The whole point: no event stream, no cancel — a plain point-in-time read.
    expect(streamSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    // resume(agentId) carries no model on the refresh path (no re-attach intent).
    expect(Agent.resume).toHaveBeenCalledWith("bc-test-cloud-0001", { apiKey: "test-key-cloud" });
    expect(Agent.getRun).toHaveBeenCalledWith("run-test-cloud-0001", {
      agentId: "bc-test-cloud-0001",
      apiKey: "test-key-cloud",
      runtime: "cloud",
    });
    expect(disposeAndAgent.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("terminal run: listArtifacts merged onto the refresh harvest result", async () => {
    const artifact = {
      path: "build/out.bin",
      sizeBytes: 99,
      updatedAt: "2026-05-29T10:00:00.000Z",
    };
    const { run, disposeAndAgent } = buildRefreshMock({
      result: {
        durationMs: 7000,
        id: "run-test-cloud-0001",
        result: "finished cloud-side",
        status: "finished",
      },
      status: "finished",
    });
    vi.mocked(disposeAndAgent.agent.listArtifacts).mockResolvedValue([artifact]);
    vi.mocked(Agent.resume).mockResolvedValue(disposeAndAgent.agent);
    vi.mocked(Agent.getRun).mockResolvedValue(run);

    const runner = new CloudCursorRunner();
    const result = await runner.refreshRun({
      agentId: "bc-test-cloud-0001",
      runId: "run-test-cloud-0001",
    });

    expect(vi.mocked(disposeAndAgent.agent.listArtifacts)).toHaveBeenCalledTimes(1);
    expect(result?.artifacts).toEqual([artifact]);
    expect(disposeAndAgent.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("still-running run: returns undefined; wait + stream never called; agent disposed", async () => {
    const { run, streamSpy, waitSpy, disposeAndAgent } = buildRefreshMock({ status: "running" });
    vi.mocked(Agent.resume).mockResolvedValue(disposeAndAgent.agent);
    vi.mocked(Agent.getRun).mockResolvedValue(run);

    const runner = new CloudCursorRunner();
    const result = await runner.refreshRun({
      agentId: "bc-test-cloud-0001",
      runId: "run-test-cloud-0001",
    });

    expect(result).toBeUndefined();
    expect(waitSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
    expect(disposeAndAgent.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("a cancelled terminal run maps to a cancelled AgentRunResult", async () => {
    const { run, disposeAndAgent } = buildRefreshMock({
      result: { durationMs: 300, id: "run-test-cloud-0001", status: "cancelled" },
      status: "cancelled",
    });
    vi.mocked(Agent.resume).mockResolvedValue(disposeAndAgent.agent);
    vi.mocked(Agent.getRun).mockResolvedValue(run);

    const runner = new CloudCursorRunner();
    const result = await runner.refreshRun({
      agentId: "bc-test-cloud-0001",
      runId: "run-test-cloud-0001",
    });

    expect(result?.status).toBe("cancelled");
  });

  test("Agent.resume UnknownAgentError → CursorAgentNotFoundError; getRun not called", async () => {
    const sdkErr = new UnknownAgentError("agent gone");
    vi.mocked(Agent.resume).mockRejectedValue(sdkErr);

    const runner = new CloudCursorRunner();
    const promise = runner.refreshRun({
      agentId: "bc-test-cloud-0001",
      runId: "run-test-cloud-0001",
    });
    await expect(promise).rejects.toBeInstanceOf(CursorAgentNotFoundError);
    expect(Agent.getRun).not.toHaveBeenCalled();
  });

  test("Agent.getRun HTTP 404 → CursorAgentNotFoundError; agent disposed", async () => {
    const { disposeAndAgent } = buildRefreshMock({ status: "running" });
    const sdkErr = new CursorSdkError("run not found", { status: 404 });
    vi.mocked(Agent.resume).mockResolvedValue(disposeAndAgent.agent);
    vi.mocked(Agent.getRun).mockRejectedValue(sdkErr);

    const runner = new CloudCursorRunner();
    await expect(
      runner.refreshRun({ agentId: "bc-test-cloud-0001", runId: "run-test-cloud-0001" }),
    ).rejects.toBeInstanceOf(CursorAgentNotFoundError);
    expect(disposeAndAgent.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("a non-not-found SDK error wraps as AgentRunFailedError", async () => {
    const { disposeAndAgent } = buildRefreshMock({ status: "running" });
    vi.mocked(Agent.resume).mockResolvedValue(disposeAndAgent.agent);
    vi.mocked(Agent.getRun).mockRejectedValue(new Error("HTTP 500"));

    const runner = new CloudCursorRunner();
    await expect(
      runner.refreshRun({ agentId: "bc-test-cloud-0001", runId: "run-test-cloud-0001" }),
    ).rejects.toBeInstanceOf(AgentRunFailedError);
    expect(disposeAndAgent.disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("throws MissingApiKeyError when CURSOR_API_KEY is unset; no SDK call", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CURSOR_API_KEY", "");
    const runner = new CloudCursorRunner();
    await expect(
      runner.refreshRun({ agentId: "bc-test-cloud-0001", runId: "run-test-cloud-0001" }),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(Agent.resume).not.toHaveBeenCalled();
  });
});

function buildRefreshMock(opts: MockRunOpts & { status: Run["status"] }): {
  run: MockRun;
  streamSpy: ReturnType<typeof vi.fn>;
  waitSpy: ReturnType<typeof vi.fn>;
  cancelSpy: ReturnType<typeof vi.fn>;
  disposeAndAgent: { agent: MockAgent; disposeSpy: ReturnType<typeof vi.fn> };
} {
  const { run, streamSpy, waitSpy, cancelSpy } = makeMockRun(opts);
  const { agent, disposeSpy } = makeMockAgent({ agentId: "bc-test-cloud-0001", run });
  return { cancelSpy, disposeAndAgent: { agent, disposeSpy }, run, streamSpy, waitSpy };
}

describe("CloudCursorRunner — runtime guards", () => {
  test("throws MissingCloudSpecError when runtime is cloud and cloud is undefined", async () => {
    const runner = new CloudCursorRunner();
    await expect(
      runner.run({
        cwd: "/x",
        model: { id: "composer-2.5" },
        onEvent: vi.fn(),
        prompt: "x",
        runtime: "cloud",
      }),
    ).rejects.toBeInstanceOf(MissingCloudSpecError);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  test("throws InvalidCloudReposError when cloud.repos is empty", async () => {
    const runner = new CloudCursorRunner();
    await expect(
      runner.run({
        cwd: "/x",
        model: { id: "composer-2.5" },
        onEvent: vi.fn(),
        prompt: "x",
        runtime: "cloud",
        cloud: { repos: [] } as unknown as CloudRunSpec, // bypass tuple typing for runtime test
      }),
    ).rejects.toBeInstanceOf(InvalidCloudReposError);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  test("throws InvalidCloudReposError when cloud.repos is missing entirely (non-array)", async () => {
    const runner = new CloudCursorRunner();
    await expect(
      runner.run({
        cwd: "/x",
        model: { id: "composer-2.5" },
        onEvent: vi.fn(),
        prompt: "x",
        runtime: "cloud",
        cloud: {} as unknown as CloudRunSpec, // simulate JSON caller with malformed cloud spec
      }),
    ).rejects.toBeInstanceOf(InvalidCloudReposError);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  test("throws InvalidCloudReposError when cloud.repos has more than one entry", async () => {
    const runner = new CloudCursorRunner();
    await expect(
      runner.run({
        cwd: "/x",
        model: { id: "composer-2.5" },
        onEvent: vi.fn(),
        prompt: "x",
        runtime: "cloud",
        cloud: {
          repos: [
            { url: "https://github.com/acme/sandbox" },
            { url: "https://github.com/acme/other" },
          ],
        } as unknown as CloudRunSpec,
      }),
    ).rejects.toBeInstanceOf(InvalidCloudReposError);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  test('throws WrongRunnerError when runtime is "local"', async () => {
    const runner = new CloudCursorRunner();
    await expect(
      runner.run(
        cloudBaseInput({
          runtime: "local",
        }),
      ),
    ).rejects.toBeInstanceOf(WrongRunnerError);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  test("throws WrongRunnerError when runtime is omitted", async () => {
    const runner = new CloudCursorRunner();
    const input = cloudBaseInput();
    const { runtime: _omit, ...rest } = input;
    await expect(runner.run(rest)).rejects.toBeInstanceOf(WrongRunnerError);
    expect(Agent.create).not.toHaveBeenCalled();
  });
});

describe("CloudCursorRunner — env / pre-run errors", () => {
  test("throws MissingApiKeyError when CURSOR_API_KEY is unset (no SDK call)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CURSOR_API_KEY", "");
    const runner = new CloudCursorRunner();
    await expect(runner.run(cloudBaseInput())).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  test("Agent.create throw → AgentRunFailedError; agent NOT disposed (none was created)", async () => {
    const sdkErr = new Error("AuthenticationError: bad key");
    vi.mocked(Agent.create).mockRejectedValue(sdkErr);
    const runner = new CloudCursorRunner();
    const promise = runner.run(cloudBaseInput());
    await expect(promise).rejects.toBeInstanceOf(AgentRunFailedError);
    await expect(promise).rejects.toThrow(/Agent\.create failed/);
    await expect(promise).rejects.toMatchObject({ cause: sdkErr });
  });

  test("agent.send throw after Agent.create → AgentRunFailedError; agent IS disposed", async () => {
    const { run } = makeMockRun({});
    const sendErr = new Error("RateLimitError");
    const { agent, disposeSpy } = makeMockAgent({ run, sendThrows: sendErr });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const promise = runner.run(cloudBaseInput());
    await expect(promise).rejects.toThrow(/agent\.send failed/);
    await expect(promise).rejects.toMatchObject({ cause: sendErr });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("Agent.create SDK reject attaches redacted causeSummary and still dumps stderr", async () => {
    const sdkErr = Object.assign(new Error("bad request body"), {
      code: "invalid_request_error",
      requestId: "req_cloud_1",
      status: 400,
    });
    vi.mocked(Agent.create).mockRejectedValue(sdkErr);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const runner = new CloudCursorRunner();
      const promise = runner.run(cloudBaseInput({ log: cloudTestLogger() }));
      await expect(promise).rejects.toBeInstanceOf(AgentRunFailedError);
      const err = await promise.catch((e: unknown) => e);
      expect(err).toMatchObject({
        causeSummary: {
          code: "invalid_request_error",
          message: "bad request body",
          requestId: "req_cloud_1",
          status: 400,
        },
        message: "Agent.create failed",
      });
      // Regression: stderr dump from logCloudStartFailure is unchanged /
      // still present alongside the new persisted causeSummary path.
      const out = stderrSpyConcat(spy);
      expect(out).toMatch(/Agent\.create failed|sdk-throw|bad request body/);
    } finally {
      spy.mockRestore();
    }
  });

  test("agent.send throw causeSummary reads non-enumerable SDK fields", async () => {
    const { run } = makeMockRun({});
    const sendErr = new Error("rate limited");
    Object.defineProperty(sendErr, "status", { value: 429, enumerable: false });
    Object.defineProperty(sendErr, "code", { value: "rate_limit", enumerable: false });
    const { agent } = makeMockAgent({ run, sendThrows: sendErr });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const err = await runner.run(cloudBaseInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunFailedError);
    expect(err).toMatchObject({
      causeSummary: { status: 429, code: "rate_limit", message: "rate limited" },
      message: "agent.send failed after Agent.create",
    });
  });

  test("disposal failure during the agent.send catch path is swallowed; original SDK error wins", async () => {
    const { run } = makeMockRun({});
    const sendErr = new Error("primary");
    const { agent, disposeSpy } = makeMockAgent({ run, sendThrows: sendErr });
    disposeSpy.mockRejectedValueOnce(new Error("dispose secondary"));
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    await expect(runner.run(cloudBaseInput())).rejects.toMatchObject({ cause: sendErr });
  });
});

describe("CloudCursorRunner — Agent.create cloud payload", () => {
  test("maps AgentRunInput.cloud into Agent.create cloud options", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const repos = [
      { prUrl: "https://github.com/acme/sandbox/pull/2", url: "https://github.com/acme/sandbox" },
    ] as const;

    const runner = new CloudCursorRunner();
    await runner.run(
      cloudBaseInput({
        agentName: "ship/wf-cloud",
        cloud: {
          autoCreatePR: true,
          env: { name: "staging", type: "pool" },
          envVars: { MY_TOKEN: "abc" },
          repos,
          skipReviewerRequest: false,
          workOnCurrentBranch: true,
        },
        mcpServers: { docs: { type: "http", url: "https://docs" } },
        model: { id: "composer-2.5", params: [{ id: "fast", value: true }] },
      }),
    );

    expect(Agent.create).toHaveBeenCalledWith({
      apiKey: "test-key-cloud",
      cloud: {
        autoCreatePR: true,
        env: { name: "staging", type: "pool" },
        envVars: { MY_TOKEN: "abc" },
        repos: [{ url: repos[0].url, prUrl: repos[0].prUrl }],
        skipReviewerRequest: false,
        workOnCurrentBranch: true,
      },
      mcpServers: { docs: { type: "http", url: "https://docs" } },
      // Boolean `true` from AgentRunInput is coerced to the string "true"
      // before being passed to Agent.create — Cursor's cloud API rejects
      // boolean param values with a 400 "[validation_error] Expected
      // string, received boolean".
      model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      name: "ship/wf-cloud",
    });
  });

  test("coerces boolean model param values to strings before Agent.create", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    await runner.run(
      cloudBaseInput({
        cloud: { repos: [{ url: "https://github.com/acme/sandbox" }] },
        model: {
          id: "composer-2.5",
          params: [
            { id: "fast", value: false },
            { id: "thinking", value: true },
            { id: "tier", value: "premium" },
          ],
        },
      }),
    );

    const arg = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(arg?.model).toEqual({
      id: "composer-2.5",
      params: [
        { id: "fast", value: "false" },
        { id: "thinking", value: "true" },
        { id: "tier", value: "premium" },
      ],
    });
  });

  test("forwards per-repo startingRef into Agent.create cloud.repos[0]", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    await runner.run(
      cloudBaseInput({
        cloud: {
          repos: [{ startingRef: "ship-l3-fixture", url: "https://github.com/acme/sandbox" }],
        },
      }),
    );

    const arg = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(arg?.cloud?.repos?.[0]).toMatchObject({
      startingRef: "ship-l3-fixture",
      url: "https://github.com/acme/sandbox",
    });
  });

  test("applies cloud defaults when autoCreatePR / workOnCurrentBranch omitted", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    await runner.run(cloudBaseInput());

    const arg = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(arg?.cloud).toEqual({
      autoCreatePR: true,
      repos: [{ url: "https://github.com/acme/sandbox" }],
      workOnCurrentBranch: false,
    });
    expect(arg?.cloud).not.toHaveProperty("skipReviewerRequest");
    expect(arg?.cloud).not.toHaveProperty("envVars");
    expect(arg?.cloud).not.toHaveProperty("env");
  });

  test("explicit autoCreatePR: false is forwarded (defaults do not override)", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    await runner.run(
      cloudBaseInput({
        cloud: {
          autoCreatePR: false,
          repos: [{ url: "https://github.com/acme/sandbox" }],
        },
      }),
    );

    const arg = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(arg?.cloud?.autoCreatePR).toBe(false);
  });
});

describe("CloudCursorRunner — cloud warnings on terminal result", () => {
  test("autoCreatePR without prUrl surfaces warnings on succeeded mapped result", async () => {
    const { run } = makeMockRun({
      result: {
        durationMs: 100,
        git: { branches: [{ repoUrl: "github.com/acme/sandbox" }] },
        id: "run-warn",
        result: "ok",
        status: "finished",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(
      cloudBaseInput({
        cloud: {
          autoCreatePR: true,
          repos: [{ url: "https://github.com/acme/sandbox" }],
        },
      }),
    );
    const mapped = await handle.result;
    expect(mapped.warnings).toContain(
      "autoCreatePR was requested but result.branches[0].prUrl is undefined",
    );
  });

  test("mapTerminalResult includes warnings at top level for autoCreatePR divergence", () => {
    const result = {
      durationMs: 50,
      git: { branches: [{ repoUrl: "github.com/acme/sandbox" }] },
      status: "finished",
    } as RunResult;
    const spec = {
      autoCreatePR: true,
      repos: [{ url: "https://github.com/acme/sandbox" }],
    } as CloudRunSpec;
    const mapped = mapTerminalResult(result, "succeeded", spec);
    // Both the autoCreatePR (no prUrl) and the branch-expected (no branch)
    // warnings fire — the persisted JSON surfaces every divergence so the
    // operator can tell whether cursor pushed-to-main vs left work dangling.
    expect(mapped).toMatchObject({
      status: "succeeded",
      warnings: [
        "autoCreatePR was requested but result.branches[0].prUrl is undefined",
        "a new branch was expected (workOnCurrentBranch !== true) but result.branches[0].branch is undefined",
      ],
    });
  });
});

describe("CloudCursorRunner — status mapping", () => {
  test('SDK status "expired" maps to failed terminal result', async () => {
    const expiredResult = {
      durationMs: 100,
      id: "run-expired",
      status: "expired",
    } as unknown as RunResult;

    const { run } = makeMockRun({ result: expiredResult });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "failed", durationMs: 100 });
  });

  test('SDK status "EXPIRED" (uppercase) maps to failed terminal result', async () => {
    const expiredResult = {
      durationMs: 100,
      id: "run-expired",
      status: "EXPIRED",
    } as unknown as RunResult;

    const { run } = makeMockRun({ result: expiredResult });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "failed", durationMs: 100 });
  });
});

describe("CloudCursorRunner — happy path + status mapping", () => {
  test("happy path: finished → succeeded, summary = result.result, durationMs preserved", async () => {
    const { run } = makeMockRun({
      events: [evA, evB],
      result: {
        durationMs: 67_000,
        id: "run-test-cloud-0001",
        result: "implementation done",
        status: "finished",
      },
    });
    const { agent, disposeSpy } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const onEvent = vi.fn();
    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput({ onEvent }));
    const result = await handle.result;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(result).toMatchObject({
      branches: [],
      durationMs: 67_000,
      status: "succeeded",
      summary: "implementation done",
    });
    expect(onEvent.mock.calls.map((c) => (c as [SDKMessage])[0])).toEqual([evA, evB]);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("terminal: listArtifacts merged onto result (success path)", async () => {
    const artifact = {
      path: "build/out.bin",
      sizeBytes: 99,
      updatedAt: "2026-05-29T10:00:00.000Z",
    };
    const { run } = makeMockRun({
      result: {
        durationMs: 1,
        id: "run-test-cloud-0001",
        result: "ok",
        status: "finished",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(agent.listArtifacts).mockResolvedValue([artifact]);
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    const result = await handle.result;

    expect(vi.mocked(agent.listArtifacts)).toHaveBeenCalledTimes(1);
    expect(result.artifacts).toEqual([artifact]);
  });

  test("terminal: stalled listArtifacts times out and proceeds without artifacts", async () => {
    vi.useFakeTimers();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { run } = makeMockRun({
      result: {
        durationMs: 1,
        id: "run-test-cloud-0001",
        result: "ok",
        status: "finished",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(agent.listArtifacts).mockReturnValue(new Promise(() => undefined));
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handlePromise = runner.run(cloudBaseInput());
    await vi.advanceTimersByTimeAsync(LIST_ARTIFACTS_TIMEOUT_MS + 1);
    const handle = await handlePromise;
    const result = await handle.result;

    expect(result.status).toBe("succeeded");
    expect(result.artifacts).toEqual([]);
    expect(stderrSpy.mock.calls.join("")).toContain("listArtifacts timed out");

    stderrSpy.mockRestore();
    vi.useRealTimers();
  });

  test("error → failed; result resolves (does NOT throw); errorMessage populated", async () => {
    const { run } = makeMockRun({
      result: {
        durationMs: 5_000,
        id: "run-test-cloud-0001",
        result: "model rejected the task",
        status: "error",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    const result = await handle.result;

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("model rejected the task");
  });

  test("error without RunResult.result → surfaces SDK status (not generic fallback)", async () => {
    const { run } = makeMockRun({
      result: { durationMs: 0, id: "run-test-cloud-0001", status: "error" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/SDK status ERROR/);
  });

  test("cancelled → cancelled; summary preserved if SDK populated it", async () => {
    const { run } = makeMockRun({
      result: {
        durationMs: 1_000,
        id: "run-test-cloud-0001",
        result: "partial output",
        status: "cancelled",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await expect(handle.result).resolves.toMatchObject({
      status: "cancelled",
      summary: "partial output",
    });
  });

  test("branches preserved from RunResult.git", async () => {
    const { run } = makeMockRun({
      result: {
        durationMs: 1_000,
        git: {
          branches: [{ branch: "feat-x", prUrl: "https://example.com/pr/1", repoUrl: "r1" }],
        },
        id: "run-test-cloud-0001",
        result: "ok",
        status: "finished",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    const result = await handle.result;
    expect(result.branches).toEqual([
      { branch: "feat-x", prUrl: "https://example.com/pr/1", repoUrl: "r1" },
    ]);
  });
});

describe("CloudCursorRunner — onEvent contract", () => {
  test("onEvent throws are swallowed; the run still resolves to its terminal status", async () => {
    const { run } = makeMockRun({ events: [evA, evB] });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const onEvent = vi.fn().mockImplementation(() => {
      throw new Error("consumer is broken");
    });
    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput({ onEvent }));
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  test("async onEvent rejection is swallowed (no unhandled rejection leaks past the runner)", async () => {
    const { run } = makeMockRun({ events: [evA, evB] });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const onEvent = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error("async consumer broke")));
    const runner = new CloudCursorRunner();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handle = await runner.run(cloudBaseInput({ onEvent }));
      await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toHaveLength(0);
      expect(onEvent).toHaveBeenCalledTimes(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stream errors but wait() recovers with a terminal RunResult", async () => {
    const streamErr = new Error("transient stream issue");
    const { run } = makeMockRun({
      result: {
        durationMs: 100,
        id: "run-test-cloud-0001",
        result: "fell back gracefully",
        status: "finished",
      },
      streamThrows: streamErr,
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
  });

  test("stream errors AND wait() rejects → AgentRunFailedError", async () => {
    const streamErr = new Error("network disconnected mid-stream");
    const { run } = makeMockRun({ streamThrows: streamErr, waitThrows: streamErr });
    const { agent, disposeSpy } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await expect(handle.result).rejects.toThrow(/stream errored/);
    await expect(handle.result).rejects.toMatchObject({ cause: streamErr });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("run.wait() rejects after a clean stream → AgentRunFailedError", async () => {
    const waitErr = new Error("SDK runtime crashed after clean stream");
    const { run } = makeMockRun({ events: [evA], waitThrows: waitErr });
    const { agent, disposeSpy } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await expect(handle.result).rejects.toThrow(/run\.wait\(\) rejected/);
    await expect(handle.result).rejects.toMatchObject({ cause: waitErr });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("CloudCursorRunner — cancellation", () => {
  test("AbortSignal pre-aborted → run.cancel() invoked exactly once", async () => {
    const { cancelSpy, run } = makeMockRun({
      result: { durationMs: 0, id: "run-test-cloud-0001", status: "cancelled" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const controller = new AbortController();
    controller.abort();
    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput({ signal: controller.signal }));
    await handle.result;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test("cancel before terminal: status=cancelled, sdkRun.cancel invoked", async () => {
    const { cancelSpy, run } = makeMockRun({
      events: [evA, evB],
      result: { durationMs: 0, id: "run-test-cloud-0001", status: "cancelled" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const controller = new AbortController();
    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput({ signal: controller.signal }));
    controller.abort();
    const result = await handle.result;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("cancelled");
  });

  test("cancel after terminal: no-op", async () => {
    const { cancelSpy, run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await handle.result;
    await handle.cancel();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  test("cancel-after-cancel: idempotent", async () => {
    const { cancelSpy, run } = makeMockRun({
      events: [evA, evB],
      result: { durationMs: 0, id: "run-test-cloud-0001", status: "cancelled" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await Promise.all([handle.cancel(), handle.cancel(), handle.cancel()]);
    await handle.result;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test("SDK cancel rejection allows retry", async () => {
    const { cancelSpy, run } = makeMockRun({
      events: [evA, evB],
      result: { durationMs: 0, id: "run-test-cloud-0001", status: "cancelled" },
    });
    cancelSpy.mockRejectedValueOnce(new Error("transient transport"));
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await handle.cancel();
    await handle.cancel();
    expect(cancelSpy).toHaveBeenCalledTimes(2);
    await handle.result;
  });
});

describe("CloudCursorRunner — agent disposal", () => {
  test("disposal failure does NOT propagate to handle.result (run outcome is what consumers see)", async () => {
    const { run } = makeMockRun({});
    const { agent, disposeSpy } = makeMockAgent({ run });
    disposeSpy.mockRejectedValueOnce(new Error("dispose blew up"));
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    const handle = await runner.run(cloudBaseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
  });
});

describe("CloudCursorRunner — IntegrationNotConnectedError", () => {
  test("wraps as CursorCloudIntegrationError preserving provider + helpUrl", async () => {
    const sdkErr = new IntegrationNotConnectedError("integration missing", {
      helpUrl: "https://cursor.com/dashboard/integrations/github",
      provider: "github",
    });
    vi.mocked(Agent.create).mockRejectedValue(sdkErr);

    const runner = new CloudCursorRunner();
    let caught: unknown;
    try {
      await runner.run(cloudBaseInput());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(CursorCloudIntegrationError);
    expect(caught).toMatchObject({
      cause: sdkErr,
      helpUrl: "https://cursor.com/dashboard/integrations/github",
      provider: "github",
    });
  });
});

function stderrSpyConcat(spy: {
  mock: { calls: readonly [string | Uint8Array, ...unknown[]][] };
}): string {
  return spy.mock.calls
    .map((call) => {
      const chunk = call[0];
      return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    })
    .join("");
}

describe("CloudCursorRunner — SHIP_CLOUD_DEBUG diagnostics", () => {
  test("SHIP_CLOUD_DEBUG=1 writes Agent.create payload + terminal map lines", async () => {
    vi.stubEnv("SHIP_CLOUD_DEBUG", "1");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk, _enc, cb) => {
      if (typeof cb === "function") cb();
      return true;
    }) as typeof process.stderr.write);
    try {
      const { run } = makeMockRun({
        result: {
          durationMs: 50,
          git: { branches: [] },
          id: "run-dbg",
          result: "ok",
          status: "finished",
        },
      });
      const { agent } = makeMockAgent({ run });
      vi.mocked(Agent.create).mockResolvedValue(agent);

      const runner = new CloudCursorRunner();
      // Default-level (info) logger — proves SHIP_CLOUD_DEBUG=1 alone surfaces the
      // diagnostics without a debug-level logger (the flag is the gate, not the level).
      const handle = await runner.run(
        cloudBaseInput({ log: createLogger({ level: "info", stream: process.stderr }) }),
      );
      await handle.result;

      const out = stderrSpyConcat(spy);
      expect(out).toContain("Agent.create payload");
      expect(out).toContain("mapTerminalResult result.git");
    } finally {
      spy.mockRestore();
    }
  });

  test("SHIP_CLOUD_DEBUG off → stderr has no prefixed diagnostic lines", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { run } = makeMockRun({});
      const { agent } = makeMockAgent({ run });
      vi.mocked(Agent.create).mockResolvedValue(agent);

      const runner = new CloudCursorRunner();
      const handle = await runner.run(cloudBaseInput());
      await handle.result;

      expect(stderrSpyConcat(spy).includes("Agent.create payload")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("debug JSON never contains the Cursor key material or literal apiKey", async () => {
    vi.stubEnv("SHIP_CLOUD_DEBUG", "1");
    vi.stubEnv("CURSOR_API_KEY", "cur_cloud_debug_must_not_echo");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { run } = makeMockRun({});
      const { agent } = makeMockAgent({ run });
      vi.mocked(Agent.create).mockResolvedValue(agent);

      const runner = new CloudCursorRunner();
      const handle = await runner.run(cloudBaseInput());
      await handle.result;

      const out = stderrSpyConcat(spy);
      expect(out.toLowerCase()).not.toContain("apikey");
      expect(out.includes("cur_cloud")).toBe(false);
      expect(out.includes("crsr_")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("debug payload redacts cloud.envVars VALUES but keeps KEYS for diagnostic visibility", async () => {
    vi.stubEnv("SHIP_CLOUD_DEBUG", "1");
    vi.stubEnv("CURSOR_API_KEY", "test-key");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { run } = makeMockRun({});
      const { agent } = makeMockAgent({ run });
      vi.mocked(Agent.create).mockResolvedValue(agent);

      const inputWithSecret = {
        ...cloudBaseInput(),
        cloud: {
          repos: [{ url: "https://github.com/owner/repo" }],
          envVars: { MY_SECRET_TOKEN: "ghp_actual_secret_value_xyz" },
        },
      } as AgentRunInput;

      const runner = new CloudCursorRunner();
      const handle = await runner.run(inputWithSecret);
      await handle.result;

      const out = stderrSpyConcat(spy);
      // KEY name is visible for diagnostics.
      expect(out).toContain("MY_SECRET_TOKEN");
      // VALUE is redacted — the literal secret never reaches stderr.
      expect(out).not.toContain("ghp_actual_secret_value_xyz");
      expect(out).toContain("[redacted]");
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Tests for `cloud-runner.ts`. SDK mocked via `vi.mock("@cursor/sdk")`.
 */

import type { AgentOptions, Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";

import { Agent, IntegrationNotConnectedError } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CloudCursorRunner } from "../src/cloud-runner.js";
import {
  CursorCloudIntegrationError,
  MissingCloudSpecError,
  WrongRunnerError,
} from "../src/errors.js";

vi.mock("@cursor/sdk", () => {
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
    },
    IntegrationNotConnectedError: IntegrationNotConnectedErrorMock,
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

function makeMockRun(opts: MockRunOpts): {
  run: MockRun;
  cancelSpy: ReturnType<typeof vi.fn>;
  waitSpy: ReturnType<typeof vi.fn>;
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

  const run: MockRun = {
    agentId: "agent-test-cloud-0001",
    cancel: cancelSpy,
    conversation: vi.fn(),
    id: runId,
    onDidChangeStatus: vi.fn(() => () => {
      /* noop unsubscribe */
    }),
    status: "running",
    // eslint-disable-next-line @typescript-eslint/require-await
    stream: async function* (): AsyncGenerator<SDKMessage, void> {
      if (opts.streamThrows !== undefined) throw toError(opts.streamThrows);
      for (const ev of events) {
        yield ev;
      }
    },
    supports: vi.fn(() => true),
    unsupportedReason: vi.fn(() => undefined),
    wait: waitSpy,
  };

  return { cancelSpy, run, waitSpy };
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
    listArtifacts: vi.fn(),
    model: undefined,
    reload: vi.fn(),
    send: sendSpy,
  };
  return { agent, disposeSpy, sendSpy };
}

function cloudBaseInput(
  overrides: Partial<Parameters<CloudCursorRunner["run"]>[0]> = {},
): Parameters<CloudCursorRunner["run"]>[0] {
  return {
    cloud: {
      repos: [{ url: "https://github.com/acme/sandbox" }],
    },
    cwd: "/tmp/cloud-unused-cwd",
    model: { id: "composer-2" },
    onEvent: vi.fn(),
    prompt: "do the cloud thing",
    runtime: "cloud",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("CURSOR_API_KEY", "test-key-cloud");
  vi.mocked(Agent.create).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CloudCursorRunner — runtime guards", () => {
  test("throws MissingCloudSpecError when runtime is cloud and cloud is undefined", async () => {
    const runner = new CloudCursorRunner();
    await expect(
      runner.run({
        cwd: "/x",
        model: { id: "composer-2" },
        onEvent: vi.fn(),
        prompt: "x",
        runtime: "cloud",
      }),
    ).rejects.toBeInstanceOf(MissingCloudSpecError);
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

describe("CloudCursorRunner — Agent.create cloud payload", () => {
  test("maps CursorRunInput.cloud into Agent.create cloud options", async () => {
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
        model: { id: "composer-2", params: [{ id: "thinking", value: "high" }] },
      }),
    );

    expect(Agent.create).toHaveBeenCalledWith({
      apiKey: "test-key-cloud",
      cloud: {
        autoCreatePR: true,
        env: { name: "staging", type: "pool" },
        envVars: { MY_TOKEN: "abc" },
        repos: [...repos],
        skipReviewerRequest: false,
        workOnCurrentBranch: true,
      },
      mcpServers: { docs: { type: "http", url: "https://docs" } },
      model: { id: "composer-2", params: [{ id: "thinking", value: "high" }] },
      name: "ship/wf-cloud",
    });
  });

  test("omits optional cloud fields when unset (exactOptionalPropertyTypes-safe)", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new CloudCursorRunner();
    await runner.run(cloudBaseInput());

    const arg = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(arg?.cloud).toEqual({
      repos: [{ url: "https://github.com/acme/sandbox" }],
    });
    expect(arg?.cloud).not.toHaveProperty("workOnCurrentBranch");
    expect(arg?.cloud).not.toHaveProperty("autoCreatePR");
    expect(arg?.cloud).not.toHaveProperty("skipReviewerRequest");
    expect(arg?.cloud).not.toHaveProperty("envVars");
    expect(arg?.cloud).not.toHaveProperty("env");
  });
});

describe("CloudCursorRunner — status mapping", () => {
  test('SDK status "expired" maps to cancelled terminal result', async () => {
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
    await expect(handle.result).resolves.toMatchObject({ status: "cancelled", durationMs: 100 });
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

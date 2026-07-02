/**
 * Tests for `local-runner.ts`. SDK mocked via `vi.mock("@cursor/sdk")`
 * so tests run without `CURSOR_API_KEY` or network.
 */

import type { AgentOptions, Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";
import type { AgentDefinition } from "@ship/agent-runner";

import { Agent } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AgentRunFailedError,
  LocalResumeNotSupportedError,
  MissingApiKeyError,
  WrongRunnerError,
} from "./errors.js";
import { LocalCursorRunner } from "./local-runner.js";

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
  },
}));

/**
 * Coerces an `unknown` thrown sentinel from test options into an
 * `Error` so the lint rule `@typescript-eslint/only-throw-error` is
 * satisfied. Tests pass `Error` instances by convention; the
 * fallback's only purpose is to widen the type.
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// Mocks satisfy the SDK interfaces directly; no wrapper interfaces
// needed. Vitest spies attached to methods stay accessible on the
// concrete object via the `Spy` getter functions returned alongside.
type MockRun = Run;
type MockAgent = SDKAgent;

interface MockRunOpts {
  events?: SDKMessage[];
  /**
   * Pre-constructed `RunResult` for `wait()` to resolve with. Tests
   * that need to explicitly OMIT a field (rather than override it)
   * construct the object inline. We don't try to merge defaults at
   * the helper level because `exactOptionalPropertyTypes` makes
   * "undefined-as-omit" patterns brittle.
   */
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
  const runId = opts.runId ?? "run-test-0001";
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
    agentId: "agent-test-0001",
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
    agentId: opts.agentId ?? "agent-test-0001",
    close: vi.fn(),
    downloadArtifact: vi.fn(),
    listArtifacts: vi.fn(),
    model: undefined,
    reload: vi.fn(),
    send: sendSpy,
  };
  return { agent, disposeSpy, sendSpy };
}

const evA: SDKMessage = {
  agent_id: "agent-test-0001",
  message: { content: [{ text: "first", type: "text" }], role: "assistant" },
  run_id: "run-test-0001",
  type: "assistant",
} as unknown as SDKMessage;

const evB: SDKMessage = {
  agent_id: "agent-test-0001",
  message: { content: [{ text: "second", type: "text" }], role: "assistant" },
  run_id: "run-test-0001",
  type: "assistant",
} as unknown as SDKMessage;

function baseInput(
  overrides: Partial<Parameters<LocalCursorRunner["run"]>[0]> = {},
): Parameters<LocalCursorRunner["run"]>[0] {
  return {
    cwd: "/tmp/test-workdir",
    model: { id: "composer-2" },
    onEvent: vi.fn(),
    prompt: "do the thing",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("CURSOR_API_KEY", "test-key-abc123");
  vi.mocked(Agent.create).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function attachBaseInput(
  overrides: Partial<Parameters<LocalCursorRunner["attach"]>[0]> = {},
): Parameters<LocalCursorRunner["attach"]>[0] {
  return {
    agentId: "agent-test-0001",
    model: { id: "composer-2" },
    onEvent: vi.fn(),
    runId: "run-test-0001",
    ...overrides,
  };
}

describe("LocalCursorRunner — attach", () => {
  test("throws LocalResumeNotSupportedError unconditionally", async () => {
    const runner = new LocalCursorRunner();
    const input = attachBaseInput({ agentId: "agent-resume-target" });
    await expect(runner.attach(input)).rejects.toBeInstanceOf(LocalResumeNotSupportedError);
    await expect(runner.attach(input)).rejects.toMatchObject({
      agentId: "agent-resume-target",
    });
    expect(Agent.create).not.toHaveBeenCalled();
  });
});

describe("LocalCursorRunner — runtime selection", () => {
  test.each([["cloud"], ["Cloud"], ["remote"], [null]])(
    "throws WrongRunnerError when runtime is %p",
    async (bad) => {
      const runner = new LocalCursorRunner();
      await expect(
        runner.run(baseInput({ runtime: bad as unknown as "local" })),
      ).rejects.toBeInstanceOf(WrongRunnerError);
      expect(Agent.create).not.toHaveBeenCalled();
    },
  );

  test("ignores input.cloud when runtime is unset", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    await runner.run(
      baseInput({
        cloud: { repos: [{ url: "https://github.com/o/r" }] },
      }),
    );

    const call = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("cloud");
    expect(call?.local).toEqual({ cwd: "/tmp/test-workdir", settingSources: ["project"] });
  });

  test('ignores input.cloud when runtime is "local"', async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    await runner.run(
      baseInput({
        cloud: { repos: [{ url: "https://github.com/o/r" }] },
        runtime: "local",
      }),
    );

    const call = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(call).not.toHaveProperty("cloud");
  });
});

describe("LocalCursorRunner — env / pre-run errors", () => {
  test("throws MissingApiKeyError when CURSOR_API_KEY is unset (no SDK call)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CURSOR_API_KEY", "");
    const runner = new LocalCursorRunner();
    await expect(runner.run(baseInput())).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  test("Agent.create throw → AgentRunFailedError; agent NOT disposed (none was created)", async () => {
    const sdkErr = new Error("AuthenticationError: bad key");
    vi.mocked(Agent.create).mockRejectedValue(sdkErr);
    const runner = new LocalCursorRunner();
    const promise = runner.run(baseInput());
    await expect(promise).rejects.toBeInstanceOf(AgentRunFailedError);
    await expect(promise).rejects.toThrow(/Agent\.create failed/);
    await expect(promise).rejects.toMatchObject({ cause: sdkErr });
  });

  test("agent.send throw after Agent.create → AgentRunFailedError; agent IS disposed", async () => {
    const { run } = makeMockRun({});
    const sendErr = new Error("RateLimitError");
    const { agent, disposeSpy } = makeMockAgent({ run, sendThrows: sendErr });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const promise = runner.run(baseInput());
    await expect(promise).rejects.toThrow(/agent\.send failed/);
    await expect(promise).rejects.toMatchObject({ cause: sendErr });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("disposal failure during the agent.send catch path is swallowed; original SDK error wins", async () => {
    const { run } = makeMockRun({});
    const sendErr = new Error("primary");
    const { agent, disposeSpy } = makeMockAgent({ run, sendThrows: sendErr });
    disposeSpy.mockRejectedValueOnce(new Error("dispose secondary"));
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    await expect(runner.run(baseInput())).rejects.toMatchObject({ cause: sendErr });
  });
});

describe("LocalCursorRunner — happy path + status mapping", () => {
  test("happy path: finished → succeeded, summary = result.result, durationMs preserved", async () => {
    const { run } = makeMockRun({
      events: [evA, evB],
      result: {
        durationMs: 67_000,
        id: "run-test-0001",
        result: "implementation done",
        status: "finished",
      },
    });
    const { agent, disposeSpy } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const onEvent = vi.fn();
    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    const result = await handle.result;

    expect(result).toMatchObject({
      branches: [],
      durationMs: 67_000,
      status: "succeeded",
      summary: "implementation done",
    });
    expect(onEvent.mock.calls.map((c) => (c as [SDKMessage])[0])).toEqual([evA, evB]);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("error-status tool_call events pass through onEvent unchanged for ndjson persistence", async () => {
    const toolErrEv = {
      agent_id: "agent-test-0001",
      call_id: "call-err-1",
      name: "shell",
      result: "database is locked",
      run_id: "run-test-0001",
      status: "error",
      type: "tool_call",
    } as unknown as SDKMessage;
    const { run } = makeMockRun({
      events: [toolErrEv],
      result: { durationMs: 1000, id: "run-test-0001", status: "error" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const onEvent = vi.fn();
    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    await handle.result;

    const forwarded = onEvent.mock.calls.map((c) => (c as [SDKMessage])[0]);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ type: "tool_call", status: "error", name: "shell" });
  });

  test("error → failed; result resolves (does NOT throw); errorMessage populated", async () => {
    const { run } = makeMockRun({
      result: {
        durationMs: 5_000,
        id: "run-test-0001",
        result: "model rejected the task",
        status: "error",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("model rejected the task");
  });

  test("error without RunResult.result → surfaces SDK status (not generic fallback)", async () => {
    const { run } = makeMockRun({
      result: { durationMs: 0, id: "run-test-0001", status: "error" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/SDK status ERROR/);
    expect(result.sdkTerminalStatus).toBe("error");
  });

  test("error with error-bearing tool_call event → errorMessage folds tool detail + SDK status", async () => {
    const toolErrEv = {
      agent_id: "agent-test-0001",
      call_id: "call-err-1",
      name: "shell",
      result: "database is locked",
      run_id: "run-test-0001",
      status: "error",
      type: "tool_call",
    } as unknown as SDKMessage;
    const statusErrEv = {
      agent_id: "agent-test-0001",
      run_id: "run-test-0001",
      status: "ERROR",
      type: "status",
    } as unknown as SDKMessage;
    const { run } = makeMockRun({
      // Natural stream order: tool_call error, then the terminal status:ERROR.
      // The specific tool_call detail must survive the trailing status event.
      events: [toolErrEv, statusErrEv],
      result: {
        durationMs: 27 * 60 * 1000,
        id: "run-test-0001",
        status: "error",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput({ maxRunDurationMs: 30 * 60 * 1000 }));
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("database is locked");
    expect(result.errorMessage).toMatch(/SDK status ERROR/);
    expect(result.errorMessage).toMatch(/27m.*cap 30m/);
    expect(result.sdkTerminalStatus).toBe("ERROR");
  });

  test("cancelled → cancelled; summary preserved if SDK populated it", async () => {
    const { run } = makeMockRun({
      result: {
        durationMs: 1_000,
        id: "run-test-0001",
        result: "partial output",
        status: "cancelled",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({
      status: "cancelled",
      summary: "partial output",
    });
  });

  test("durationMs defaults to 0 when SDK omits it", async () => {
    // Construct without durationMs so the runner sees the optional as
    // missing (SDK type marks it optional; some error paths skip it).
    const { run } = makeMockRun({
      result: { id: "run-test-0001", status: "finished" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({ durationMs: 0 });
  });

  test("branches preserved from RunResult.git (cloud-shape forward-compat)", async () => {
    const { run } = makeMockRun({
      result: {
        durationMs: 1_000,
        git: {
          branches: [{ branch: "feat-x", prUrl: "https://example.com/pr/1", repoUrl: "r1" }],
        },
        id: "run-test-0001",
        result: "ok",
        status: "finished",
      },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.branches).toEqual([
      { branch: "feat-x", prUrl: "https://example.com/pr/1", repoUrl: "r1" },
    ]);
  });
});

describe("LocalCursorRunner — onEvent contract", () => {
  test("onEvent throws are swallowed; the run still resolves to its terminal status", async () => {
    const { run } = makeMockRun({ events: [evA, evB] });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const onEvent = vi.fn().mockImplementation(() => {
      throw new Error("consumer is broken");
    });
    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput({ onEvent }));
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    // Both events were attempted despite each throwing.
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  test("async onEvent rejection is swallowed (no unhandled rejection leaks past the runner)", async () => {
    // TS permits an async fn to satisfy `=> void`; without async-aware
    // swallow logic the rejection would leak past the runner.
    const { run } = makeMockRun({ events: [evA, evB] });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const onEvent = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error("async consumer broke")));
    const runner = new LocalCursorRunner();
    // Trap unhandled rejections at the process level for this test —
    // the swallow must hold even under Node's strict-mode default.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handle = await runner.run(baseInput({ onEvent }));
      await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
      // Give the microtask queue a tick to flush any leaked rejections.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toHaveLength(0);
      expect(onEvent).toHaveBeenCalledTimes(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stream errors with no terminal RunResult → handle.result rejects with AgentRunFailedError", async () => {
    const streamErr = new Error("network disconnected mid-stream");
    const { run } = makeMockRun({ streamThrows: streamErr, waitThrows: streamErr });
    const { agent, disposeSpy } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).rejects.toThrow(/stream errored/);
    await expect(handle.result).rejects.toMatchObject({ cause: streamErr });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("clean stream + wait() rejection → handle.result rejects (does not hang forever)", async () => {
    // If stream completes normally but wait() rejects, the pipeline
    // must surface the failure via handle.result rather than letting
    // the rejection escape as unhandled.
    const waitErr = new Error("SDK runtime crashed after clean stream");
    const { run } = makeMockRun({ events: [evA], waitThrows: waitErr });
    const { agent, disposeSpy } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).rejects.toThrow(/run\.wait\(\) rejected/);
    await expect(handle.result).rejects.toThrow(/SDK runtime crashed/);
    await expect(handle.result).rejects.toMatchObject({ cause: waitErr });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("stream error with a recoverable wait() RunResult → handle.result resolves with that terminal", async () => {
    // Some SDK errors make the stream throw but wait() can still produce
    // a structured terminal result. We prefer the terminal over re-
    // throwing in this case.
    const streamErr = new Error("transient stream issue");
    const { run } = makeMockRun({
      result: {
        durationMs: 100,
        id: "run-test-0001",
        result: "fell back gracefully",
        status: "finished",
      },
      streamThrows: streamErr,
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
  });
});

describe("LocalCursorRunner — cancellation", () => {
  test("handle.cancel() invokes run.cancel(); cancel-after-terminal does NOT call SDK cancel again", async () => {
    const { cancelSpy, run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await handle.result;
    // Run terminated naturally. Calling cancel now should be a no-op.
    await handle.cancel();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  test("AbortSignal pre-aborted → run.cancel() invoked exactly once", async () => {
    const { cancelSpy, run } = makeMockRun({
      result: { durationMs: 0, id: "run-test-0001", status: "cancelled" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const controller = new AbortController();
    controller.abort();
    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    await handle.result;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test("AbortSignal mid-flight → run.cancel() invoked; result resolves with mapped status", async () => {
    const { cancelSpy, run } = makeMockRun({
      events: [evA, evB],
      result: { durationMs: 0, id: "run-test-0001", status: "cancelled" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const controller = new AbortController();
    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    controller.abort();
    const result = await handle.result;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("cancelled");
  });

  test("multiple cancel() calls only invoke SDK run.cancel once (idempotency)", async () => {
    const { cancelSpy, run } = makeMockRun({
      events: [evA, evB],
      result: { durationMs: 0, id: "run-test-0001", status: "cancelled" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await Promise.all([handle.cancel(), handle.cancel(), handle.cancel()]);
    await handle.result;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test("SDK run.cancel() throwing is swallowed at the runner boundary (cancel call still resolves)", async () => {
    const { run } = makeMockRun({
      cancelThrows: new Error("SDK cancel-after-terminal threw"),
      events: [evA],
      result: { durationMs: 0, id: "run-test-0001", status: "cancelled" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.cancel()).resolves.toBeUndefined();
    await handle.result;
  });

  test("transient SDK cancel failure does NOT permanently disable cancel — second call retries", async () => {
    // If cancelInitiated stays `true` after a rejected sdkRun.cancel(),
    // all subsequent cancel attempts no-op while the run continues.
    // Retry must succeed.
    const { cancelSpy, run } = makeMockRun({
      events: [evA, evB],
      result: { durationMs: 0, id: "run-test-0001", status: "cancelled" },
    });
    // First call rejects, second succeeds.
    cancelSpy.mockRejectedValueOnce(new Error("transient transport"));
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    // First cancel: SDK rejects, runner swallows + resets cancelInitiated.
    await handle.cancel();
    // Second cancel: should reach the SDK again.
    await handle.cancel();
    expect(cancelSpy).toHaveBeenCalledTimes(2);
    await handle.result;
  });
});

describe("LocalCursorRunner — agent disposal", () => {
  test("successful run disposes the agent exactly once", async () => {
    const { run } = makeMockRun({});
    const { agent, disposeSpy } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await handle.result;
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("disposal happens even if the stream errors", async () => {
    const { run } = makeMockRun({ streamThrows: new Error("x"), waitThrows: new Error("x") });
    const { agent, disposeSpy } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).rejects.toBeDefined();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("disposal failure does NOT propagate to handle.result (run outcome is what consumers see)", async () => {
    const { run } = makeMockRun({});
    const { agent, disposeSpy } = makeMockAgent({ run });
    disposeSpy.mockRejectedValueOnce(new Error("dispose blew up"));
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
  });
});

describe("LocalCursorRunner — SDK options forwarding", () => {
  test('always passes local.settingSources: ["project"]', async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    await runner.run(baseInput());

    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        local: { cwd: "/tmp/test-workdir", settingSources: ["project"] },
      }),
    );
  });

  test("apiKey forwarded from env; cwd / model / mcpServers / agentName forwarded from input", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const mcpServers = { docs: { type: "http" as const, url: "https://x" } };
    const runner = new LocalCursorRunner();
    await runner.run(
      baseInput({
        agentName: "ship/wf-123",
        cwd: "/abs/work",
        mcpServers,
        model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      }),
    );

    expect(Agent.create).toHaveBeenCalledWith({
      apiKey: "test-key-abc123",
      local: { cwd: "/abs/work", settingSources: ["project"] },
      mcpServers,
      model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      name: "ship/wf-123",
    });
  });

  test("passes agents through to Agent.create when input.agents is set", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const agents: Record<string, AgentDefinition> = {
      "code-reviewer": { description: "d", prompt: "p" },
    };
    const runner = new LocalCursorRunner();
    await runner.run(baseInput({ agents }));

    const createArg = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(createArg?.agents).toBe(agents);
    expect(createArg?.local?.settingSources).toEqual(["project"]);
    expect(createArg?.local?.cwd).toBe("/tmp/test-workdir");
  });

  test("optional fields omitted from Agent.create when not provided (no undefined leakage)", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    await runner.run(baseInput()); // no agentName, no mcpServers, no agents

    const call = vi.mocked(Agent.create).mock.calls[0]?.[0] as AgentOptions | undefined;
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("name");
    expect(call).not.toHaveProperty("mcpServers");
    expect(call).not.toHaveProperty("agents");
  });
});

describe("LocalCursorRunner — handle shape", () => {
  test("handle.agentId and handle.runId pass through from the SDK", async () => {
    const { run } = makeMockRun({ runId: "run-uuid-99" });
    const { agent } = makeMockAgent({ run, agentId: "agent-uuid-99" });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    expect(handle.agentId).toBe("agent-uuid-99");
    expect(handle.runId).toBe("run-uuid-99");
    await handle.result;
  });
});

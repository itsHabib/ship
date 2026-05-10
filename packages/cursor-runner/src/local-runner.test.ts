/**
 * Tests for `local-runner.ts`.
 *
 * The SDK is mocked at the module boundary via `vi.mock("@cursor/sdk")`
 * so these tests run without `CURSOR_API_KEY` and without network. The
 * mock exposes `Agent.create` as a vi.fn() that the per-test setup
 * configures with whatever `SDKAgent` / `Run` shape the test needs.
 *
 * Coverage maps to the validation plan's "LocalCursorRunner" section
 * in `phases/05-cursor-runner.md`. The cancellation-timing assertion
 * (<30s) is a no-op against the mock — that bound exists for the live
 * path; Spike v2 informs whether to tighten it post-merge.
 */

import type { Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";

import { Agent } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CursorRunFailedError, MissingApiKeyError } from "./errors.js";
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

describe("LocalCursorRunner — env / pre-run errors", () => {
  test("throws MissingApiKeyError when CURSOR_API_KEY is unset (no SDK call)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CURSOR_API_KEY", "");
    const runner = new LocalCursorRunner();
    await expect(runner.run(baseInput())).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  test("Agent.create throw → CursorRunFailedError; agent NOT disposed (none was created)", async () => {
    const sdkErr = new Error("AuthenticationError: bad key");
    vi.mocked(Agent.create).mockRejectedValue(sdkErr);
    const runner = new LocalCursorRunner();
    const promise = runner.run(baseInput());
    await expect(promise).rejects.toBeInstanceOf(CursorRunFailedError);
    await expect(promise).rejects.toThrow(/Agent\.create failed/);
    await expect(promise).rejects.toMatchObject({ cause: sdkErr });
  });

  test("agent.send throw after Agent.create → CursorRunFailedError; agent IS disposed", async () => {
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

  test("error without RunResult.result → falls back to a generic errorMessage", async () => {
    // Construct without `result` field so the runner sees `undefined`
    // via the optional getter — this is what the SDK does in some
    // failure modes.
    const { run } = makeMockRun({
      result: { durationMs: 0, id: "run-test-0001", status: "error" },
    });
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    const handle = await runner.run(baseInput());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/Cursor SDK reported error/);
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

  test("stream errors with no terminal RunResult → handle.result rejects with CursorRunFailedError", async () => {
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
        model: { id: "composer-2", params: [{ id: "thinking", value: "high" }] },
      }),
    );

    expect(Agent.create).toHaveBeenCalledWith({
      apiKey: "test-key-abc123",
      local: { cwd: "/abs/work" },
      mcpServers,
      model: { id: "composer-2", params: [{ id: "thinking", value: "high" }] },
      name: "ship/wf-123",
    });
  });

  test("optional fields omitted from Agent.create when not provided (no undefined leakage)", async () => {
    const { run } = makeMockRun({});
    const { agent } = makeMockAgent({ run });
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const runner = new LocalCursorRunner();
    await runner.run(baseInput()); // no agentName, no mcpServers

    const call = vi.mocked(Agent.create).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("name");
    expect(call).not.toHaveProperty("mcpServers");
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

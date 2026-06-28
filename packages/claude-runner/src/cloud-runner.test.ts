/**
 * Tests for `cloud-runner.ts` — `CloudClaudeRunner`.
 * Mocks the `cloud-session.js` SDK seam; drives the REAL `cloud-terminal-map`
 * reducer with canned streams (L3 happy path + L2 failure modes + attach/dedup).
 */

import type { AgentRunInput } from "@ship/agent-runner";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CloudStreamEvent } from "./cloud-session.js";

vi.mock("./cloud-session.js", () => ({
  buildClient: vi.fn(() => ({})),
  readGitHubToken: vi.fn(() => "ghp_test_token"),
  ensureEnvironment: vi.fn(),
  ensureAgent: vi.fn(),
  createSession: vi.fn(),
  dispatch: vi.fn(),
  openStream: vi.fn(),
  listEvents: vi.fn(),
  interruptAndArchive: vi.fn(),
  archiveOwned: vi.fn(),
}));

import { CloudClaudeRunner } from "./cloud-runner.js";
import {
  archiveOwned,
  createSession,
  dispatch,
  ensureAgent,
  ensureEnvironment,
  interruptAndArchive,
  listEvents,
  openStream,
  readGitHubToken,
} from "./cloud-session.js";
import {
  CloudSessionError,
  InvalidCloudReposError,
  MissingApiKeyError,
  MissingCloudSpecError,
  WrongRunnerError,
} from "./errors.js";

const API_KEY_ENV = "ANTHROPIC_API_KEY";

async function* streamOf(events: readonly CloudStreamEvent[]): AsyncGenerator<CloudStreamEvent> {
  await Promise.resolve();
  for (const item of events) yield item;
}

function ev(obj: Record<string, unknown>): CloudStreamEvent {
  return obj as unknown as CloudStreamEvent;
}

const AGENT_MSG = ev({
  id: "e-msg",
  type: "agent.message",
  content: [{ type: "text", text: "done" }],
});
const IDLE_END_TURN = ev({
  id: "e-idle",
  type: "session.status_idle",
  stop_reason: { type: "end_turn" },
});
const IDLE_RETRIES = ev({
  id: "e-idle2",
  type: "session.status_idle",
  stop_reason: { type: "retries_exhausted" },
});
const TERMINATED = ev({ id: "e-term", type: "session.status_terminated" });
function errorEvent(type: string, message: string): CloudStreamEvent {
  return ev({
    id: `e-err-${type}`,
    type: "session.error",
    error: { type, message, retry_status: { type: "terminal" } },
  });
}

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  const onEvent = overrides.onEvent ?? ((): void => undefined);
  return {
    cwd: "/tmp/x",
    prompt: "implement it",
    model: { id: "claude-sonnet-4-6" },
    runtime: "cloud",
    cloud: { repos: [{ url: "https://github.com/acme/test", prBranch: "ship/x" }] },
    onEvent,
    ...overrides,
  } as AgentRunInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(API_KEY_ENV, "sk-ant-test");
  vi.mocked(readGitHubToken).mockReturnValue("ghp_test_token");
  vi.mocked(ensureEnvironment).mockResolvedValue({ id: "env-1", owned: true });
  vi.mocked(ensureAgent).mockResolvedValue({ id: "agt-1", owned: true });
  vi.mocked(createSession).mockResolvedValue("ses-1");
  vi.mocked(dispatch).mockResolvedValue(undefined);
  vi.mocked(listEvents).mockResolvedValue([]);
  vi.mocked(interruptAndArchive).mockResolvedValue(undefined);
  vi.mocked(archiveOwned).mockResolvedValue(undefined);
  vi.mocked(openStream).mockResolvedValue(streamOf([]));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CloudClaudeRunner.run — input guards", () => {
  test("rejects runtime !== cloud with WrongRunnerError", async () => {
    const runner = new CloudClaudeRunner();
    await expect(runner.run(makeInput({ runtime: "local" }))).rejects.toBeInstanceOf(
      WrongRunnerError,
    );
  });

  test("rejects missing cloud spec with MissingCloudSpecError", async () => {
    const runner = new CloudClaudeRunner();
    const input = makeInput();
    delete (input as { cloud?: unknown }).cloud;
    await expect(runner.run(input)).rejects.toBeInstanceOf(MissingCloudSpecError);
  });

  test("rejects multi-repo cloud spec with InvalidCloudReposError", async () => {
    const runner = new CloudClaudeRunner();
    const input = makeInput();
    (input as unknown as { cloud: { repos: unknown[] } }).cloud.repos = [
      { url: "a" },
      { url: "b" },
    ];
    await expect(runner.run(input)).rejects.toBeInstanceOf(InvalidCloudReposError);
  });

  test("rejects missing ANTHROPIC_API_KEY with MissingApiKeyError", async () => {
    vi.stubEnv(API_KEY_ENV, "");
    const runner = new CloudClaudeRunner();
    await expect(runner.run(makeInput())).rejects.toBeInstanceOf(MissingApiKeyError);
  });
});

describe("CloudClaudeRunner.run — happy path (L3)", () => {
  test("agent.message + status_idle{end_turn} → succeeded with summary, branches []", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([AGENT_MSG, IDLE_END_TURN]));
    const seen: CloudStreamEvent[] = [];
    const runner = new CloudClaudeRunner();
    const handle = await runner.run(
      makeInput({ onEvent: (e) => void seen.push(e as CloudStreamEvent) }),
    );
    const result = await handle.result;

    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("done");
    expect(result.branches).toEqual([]);
    // events passed through to onEvent
    expect(seen).toHaveLength(2);
    // owned env + agent archived in the pipeline finally (runs just after result resolves)
    await vi.waitFor(() => {
      expect(vi.mocked(archiveOwned)).toHaveBeenCalledOnce();
    });
    const archiveArg = vi.mocked(archiveOwned).mock.calls[0]?.[1];
    expect(archiveArg).toMatchObject({ ownedAgent: true, ownedEnv: true, sessionId: "ses-1" });
  });

  test("ensure/createSession/dispatch wired with the model + repo", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([IDLE_END_TURN]));
    const runner = new CloudClaudeRunner();
    await (
      await runner.run(makeInput())
    ).result;
    expect(vi.mocked(ensureAgent).mock.calls[0]?.[1]).toMatchObject({
      modelId: "claude-sonnet-4-6",
    });
    expect(vi.mocked(createSession).mock.calls[0]?.[1]).toMatchObject({
      repoUrl: "https://github.com/acme/test",
      pat: "ghp_test_token",
    });
    expect(vi.mocked(dispatch)).toHaveBeenCalledOnce();
  });
});

describe("CloudClaudeRunner.run — failure modes (L2)", () => {
  test("status_idle{retries_exhausted} → failed budget-exceeded", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([IDLE_RETRIES]));
    const result = await (await new CloudClaudeRunner().run(makeInput())).result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("budget-exceeded");
  });

  test("session.error{billing_error} then terminated → failed budget-exceeded", async () => {
    vi.mocked(openStream).mockResolvedValue(
      streamOf([errorEvent("billing_error", "out of credits"), TERMINATED]),
    );
    const result = await (await new CloudClaudeRunner().run(makeInput())).result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("budget-exceeded");
    expect(result.errorMessage).toContain("out of credits");
  });

  test("session.error{model_overloaded_error} then terminated → failed gateway-unreachable", async () => {
    vi.mocked(openStream).mockResolvedValue(
      streamOf([errorEvent("model_overloaded_error", "overloaded"), TERMINATED]),
    );
    const result = await (await new CloudClaudeRunner().run(makeInput())).result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("gateway-unreachable");
  });

  test("openStream throws a connection error → failed gateway-unreachable", async () => {
    vi.mocked(openStream).mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));
    const result = await (await new CloudClaudeRunner().run(makeInput())).result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("gateway-unreachable");
  });

  test("stream ends without a terminal session status → failed sdk-throw", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([AGENT_MSG]));
    const result = await (await new CloudClaudeRunner().run(makeInput())).result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("sdk-throw");
  });

  test("a throw mid-stream → failed (finalized, not rejected)", async () => {
    vi.mocked(openStream).mockResolvedValue(
      (async function* (): AsyncIterable<CloudStreamEvent> {
        await Promise.resolve();
        yield AGENT_MSG;
        throw new Error("ENOTFOUND gateway");
      })(),
    );
    const result = await (await new CloudClaudeRunner().run(makeInput())).result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("gateway-unreachable");
  });
});

describe("CloudClaudeRunner.run — pre-dispatch failures reject + clean up", () => {
  test("missing GitHub token → run rejects (CloudSessionError) and archives owned resources", async () => {
    vi.mocked(readGitHubToken).mockReturnValue(undefined);
    const runP = new CloudClaudeRunner().run(makeInput());
    await expect(runP).rejects.toBeInstanceOf(CloudSessionError);
    await expect(runP).rejects.toThrow(/cloud session setup failed/);
    expect(vi.mocked(archiveOwned)).toHaveBeenCalledOnce();
  });

  test("createSession throws → run rejects and archives owned resources", async () => {
    vi.mocked(createSession).mockRejectedValue(new Error("403 forbidden"));
    await expect(new CloudClaudeRunner().run(makeInput())).rejects.toThrow(
      /cloud session setup failed/,
    );
    expect(vi.mocked(archiveOwned)).toHaveBeenCalledOnce();
  });
});

describe("CloudClaudeRunner.cancel", () => {
  test("handle.cancel() invokes interruptAndArchive", async () => {
    // openStream never resolves → the pipeline is live (not terminated) when we cancel.
    vi.mocked(openStream).mockReturnValue(
      new Promise<AsyncIterable<CloudStreamEvent>>(() => undefined),
    );
    const handle = await new CloudClaudeRunner().run(makeInput());
    await handle.cancel();
    expect(vi.mocked(interruptAndArchive)).toHaveBeenCalledWith(expect.anything(), "ses-1");
  });
});

describe("CloudClaudeRunner.attach", () => {
  test("rejects missing ANTHROPIC_API_KEY", async () => {
    vi.stubEnv(API_KEY_ENV, "");
    await expect(
      new CloudClaudeRunner().attach({
        agentId: "ses-1",
        runId: "ses-1",
        model: { id: "claude-sonnet-4-6" },
        onEvent: () => undefined,
      }),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  test("dedups replayed history by id and resolves once on terminal", async () => {
    // History already contains AGENT_MSG (id e-msg); the re-stream replays it + adds terminal.
    vi.mocked(listEvents).mockResolvedValue([{ id: "e-msg" } as never]);
    vi.mocked(openStream).mockResolvedValue(streamOf([AGENT_MSG, IDLE_END_TURN]));
    const seen: CloudStreamEvent[] = [];
    const handle = await new CloudClaudeRunner().attach({
      agentId: "ses-1",
      runId: "ses-1",
      model: { id: "claude-sonnet-4-6" },
      onEvent: (e) => void seen.push(e as CloudStreamEvent),
    });
    const result = await handle.result;
    expect(result.status).toBe("succeeded");
    // ship.resumed emitted first; AGENT_MSG deduped (already in history); IDLE_END_TURN passes.
    const types = seen.map((e) => (e as { type?: string }).type);
    expect(types[0]).toBe("ship.resumed");
    expect(types).not.toContain("agent.message");
    expect(types).toContain("session.status_idle");
  });

  test("recovers a session that terminated offline (terminal in history)", async () => {
    // History already carries the terminal; the live stream yields nothing new.
    vi.mocked(listEvents).mockResolvedValue([AGENT_MSG, IDLE_END_TURN] as never);
    vi.mocked(openStream).mockResolvedValue(streamOf([]));
    const handle = await new CloudClaudeRunner().attach({
      agentId: "ses-1",
      runId: "ses-1",
      model: { id: "claude-sonnet-4-6" },
      onEvent: () => undefined,
    });
    const result = await handle.result;
    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("done");
  });
});

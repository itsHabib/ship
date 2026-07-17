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
  readGitHubMcpUrl: vi.fn(() => undefined),
  ensureEnvironment: vi.fn(),
  ensureAgent: vi.fn(),
  createSession: vi.fn(),
  dispatch: vi.fn(),
  openStream: vi.fn(),
  listEvents: vi.fn(),
  interruptAndArchive: vi.fn(),
  archiveOwned: vi.fn(),
}));

import type { GhResult, GhRunner } from "./cloud-branch-reconstruct.js";

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
  readGitHubMcpUrl,
  readGitHubToken,
} from "./cloud-session.js";

// A `gh` runner fake so reconstruction's fallback never shells the host binary.
// Defaults: no PR found (`[]`), branch absent (exit 1) — i.e. branch-not-found.
function fakeGh(opts: { prList?: GhResult; branch?: GhResult } = {}): GhRunner {
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(opts.prList ?? { stdout: "[]", exitCode: 0 });
    }
    if (args[0] === "api") {
      return Promise.resolve(opts.branch ?? { stdout: "", exitCode: 1 });
    }
    return Promise.resolve({ stdout: "", exitCode: 1 });
  };
}

const PR_TOOL_USE = ev({
  id: "e-pru",
  type: "agent.mcp_tool_use",
  mcp_server_name: "github",
  name: "create_pull_request",
  input: {},
});
function prToolResult(body: Record<string, unknown>): CloudStreamEvent {
  return ev({
    id: "e-prr",
    type: "agent.mcp_tool_result",
    mcp_tool_use_id: "e-pru",
    content: [{ type: "text", text: JSON.stringify(body) }],
  });
}
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CloudSessionError,
  CredentialSourcePolicyError,
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

// Let the detached `#runPipeline` finally-block (cleanup/archive) settle so that
// assertions on archive calls observe completed teardown, not a pending microtask.
const flushPipeline = (): Promise<void> =>
  new Promise<void>((resolve) => void setTimeout(resolve, 0));

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
  vi.mocked(readGitHubMcpUrl).mockReturnValue(undefined);
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

// The credential chokepoint must apply to cloud dispatch too — a cloud stream is
// not a bypass for a repo's `.ship.json` credentials constraint (parity with the
// local runner).
describe("CloudClaudeRunner.run — credential-source guard (parity)", () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ship-cloud-cred-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  function pin(content: Record<string, unknown>): void {
    writeFileSync(join(repoRoot, ".ship.json"), JSON.stringify({ credentials: content }), "utf8");
  }

  test("refuses when the pinned token source is absent", async () => {
    pin({ claude_token_env: "WORK_ANTHROPIC_TOKEN" });
    const runner = new CloudClaudeRunner();
    await expect(runner.run(makeInput({ cwd: repoRoot }))).rejects.toBeInstanceOf(
      CredentialSourcePolicyError,
    );
  });

  test("refuses when a forbidden env override is present", async () => {
    pin({ forbid_env: ["ANTHROPIC_BASE_URL"] });
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://personal.example");
    const runner = new CloudClaudeRunner();
    await expect(runner.run(makeInput({ cwd: repoRoot }))).rejects.toBeInstanceOf(
      CredentialSourcePolicyError,
    );
  });

  test("proceeds using the pinned token when the source is present", async () => {
    pin({ claude_token_env: "WORK_ANTHROPIC_TOKEN" });
    vi.stubEnv("WORK_ANTHROPIC_TOKEN", "sk-work-123");
    const runner = new CloudClaudeRunner();
    await expect(runner.run(makeInput({ cwd: repoRoot }))).resolves.toBeDefined();
  });
});

describe("CloudClaudeRunner.run — happy path (L3)", () => {
  test("end_turn + create_pull_request stream result → succeeded, branches[0] from primary parse", async () => {
    vi.mocked(openStream).mockResolvedValue(
      streamOf([
        AGENT_MSG,
        PR_TOOL_USE,
        prToolResult({ html_url: "https://github.com/acme/test/pull/7", headRefName: "ship/x" }),
        IDLE_END_TURN,
      ]),
    );
    const seen: CloudStreamEvent[] = [];
    // gh that would fail the fallback — proves the branch came from the stream (primary).
    const runner = new CloudClaudeRunner(fakeGh());
    const handle = await runner.run(
      makeInput({ onEvent: (e) => void seen.push(e as CloudStreamEvent) }),
    );
    const result = await handle.result;

    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("done");
    expect(result.branches).toEqual([
      {
        repoUrl: "https://github.com/acme/test",
        branch: "ship/x",
        prUrl: "https://github.com/acme/test/pull/7",
      },
    ]);
    // all four events passed through to onEvent
    expect(seen).toHaveLength(4);
    // owned env + agent archived in the pipeline finally (runs just after result resolves)
    await vi.waitFor(() => {
      expect(vi.mocked(archiveOwned)).toHaveBeenCalledOnce();
    });
    const archiveArg = vi.mocked(archiveOwned).mock.calls[0]?.[1];
    expect(archiveArg).toMatchObject({ ownedAgent: true, ownedEnv: true, sessionId: "ses-1" });
  });

  test("ensure/createSession/dispatch wired with the model + repo; dispatch prompt prescribes the branch", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([IDLE_END_TURN]));
    const runner = new CloudClaudeRunner(
      fakeGh({
        prList: {
          stdout: JSON.stringify([
            { url: "https://github.com/acme/test/pull/9", headRefName: "ship/x" },
          ]),
          exitCode: 0,
        },
      }),
    );
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
    // The prescribed-branch delivery instruction is appended to the prompt.
    const dispatchedPrompt = vi.mocked(dispatch).mock.calls[0]?.[2];
    expect(dispatchedPrompt).toContain("ship/x");
    expect(dispatchedPrompt).toContain("push");
  });
});

describe("CloudClaudeRunner.run — branch reconstruction (3b)", () => {
  test("no PR in stream → gh fallback finds the PR → branches[0]", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([AGENT_MSG, IDLE_END_TURN]));
    const runner = new CloudClaudeRunner(
      fakeGh({
        prList: {
          stdout: JSON.stringify([
            { url: "https://github.com/acme/test/pull/12", headRefName: "ship/x" },
          ]),
          exitCode: 0,
        },
      }),
    );
    const result = await (await runner.run(makeInput())).result;
    expect(result.status).toBe("succeeded");
    expect(result.branches).toEqual([
      {
        repoUrl: "https://github.com/acme/test",
        branch: "ship/x",
        prUrl: "https://github.com/acme/test/pull/12",
      },
    ]);
  });

  test("no PR + gh finds a branch but no PR → branches[0] without prUrl", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([IDLE_END_TURN]));
    const runner = new CloudClaudeRunner(
      fakeGh({ prList: { stdout: "[]", exitCode: 0 }, branch: { stdout: "{}", exitCode: 0 } }),
    );
    const result = await (await runner.run(makeInput())).result;
    expect(result.status).toBe("succeeded");
    expect(result.branches).toEqual([
      { repoUrl: "https://github.com/acme/test", branch: "ship/x" },
    ]);
  });

  test("end_turn but no branch anywhere → failed branch-not-found (FR5)", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([IDLE_END_TURN]));
    const runner = new CloudClaudeRunner(fakeGh());
    const result = await (await runner.run(makeInput())).result;
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("logic");
    expect(result.sdkTerminalStatus).toBe("branch-not-found");
    expect(result.errorMessage).toContain("ship/x");
  });

  test("no prBranch (3a / cursor-shaped spec) → no reconstruction, branches []", async () => {
    vi.mocked(openStream).mockResolvedValue(streamOf([IDLE_END_TURN]));
    const input = makeInput();
    (input as unknown as { cloud: { repos: { url: string }[] } }).cloud.repos = [
      { url: "https://github.com/acme/test" },
    ];
    // gh must NOT be consulted when there's no prescribed branch.
    const runner = new CloudClaudeRunner(() =>
      Promise.reject(new Error("gh must not run without prBranch")),
    );
    const result = await (await runner.run(input)).result;
    expect(result.status).toBe("succeeded");
    expect(result.branches).toEqual([]);
  });

  test("GITHUB_MCP_URL set → ensureAgent gets githubMcpUrl + prompt names the MCP tool", async () => {
    vi.mocked(readGitHubMcpUrl).mockReturnValue("https://mcp.example/github");
    vi.mocked(openStream).mockResolvedValue(
      streamOf([
        PR_TOOL_USE,
        prToolResult({ html_url: "https://github.com/acme/test/pull/3", headRefName: "ship/x" }),
        IDLE_END_TURN,
      ]),
    );
    const runner = new CloudClaudeRunner(fakeGh());
    await (
      await runner.run(makeInput())
    ).result;
    expect(vi.mocked(ensureAgent).mock.calls[0]?.[1]).toMatchObject({
      githubMcpUrl: "https://mcp.example/github",
    });
    expect(vi.mocked(dispatch).mock.calls[0]?.[2]).toContain("create_pull_request");
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

  test("a token-bearing GITHUB_MCP_URL is redacted from the setup-failure dump", async () => {
    const secretUrl = "https://ghp_SUPERSECRET@mcp.example.com/gh";
    vi.mocked(readGitHubMcpUrl).mockReturnValue(secretUrl);
    // The SDK error echoes the request (incl. the mcp_servers url) — simulate it.
    vi.mocked(ensureAgent).mockRejectedValue(
      new Error(`agents.create failed for mcp url ${secretUrl}`),
    );
    const logError = vi.fn();
    const log = {
      error: logError,
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as unknown as NonNullable<AgentRunInput["log"]>;

    await expect(new CloudClaudeRunner().run(makeInput({ log }))).rejects.toThrow(
      /cloud session setup failed/,
    );

    const setupFailure = logError.mock.calls.find((c) => c[1] === "cloud session setup failed");
    expect(setupFailure).toBeDefined();
    const dump = (setupFailure?.[0] as { err?: string }).err ?? "";
    expect(dump).not.toContain("ghp_SUPERSECRET");
    expect(dump).not.toContain(secretUrl);
    expect(dump).toContain("<GITHUB_MCP_URL redacted>");
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
    const seen: CloudStreamEvent[] = [];
    const handle = await new CloudClaudeRunner().attach({
      agentId: "ses-1",
      runId: "ses-1",
      model: { id: "claude-sonnet-4-6" },
      onEvent: (e) => void seen.push(e as CloudStreamEvent),
    });
    const result = await handle.result;
    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("done");
    // resume signal still reaches consumers even though the session finished offline
    expect((seen[0] as { type?: string } | undefined)?.type).toBe("ship.resumed");
  });

  test("recovers an offline-completed session even when openStream fails", async () => {
    // Stream-open fails, but the already-fetched history carries the terminal — the
    // reducer must still replay it and resolve the attach as success.
    vi.mocked(listEvents).mockResolvedValue([AGENT_MSG, IDLE_END_TURN] as never);
    vi.mocked(openStream).mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));
    const seen: CloudStreamEvent[] = [];
    const handle = await new CloudClaudeRunner().attach({
      agentId: "ses-1",
      runId: "ses-1",
      model: { id: "claude-sonnet-4-6" },
      onEvent: (e) => void seen.push(e as CloudStreamEvent),
    });
    const result = await handle.result;
    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("done");
    expect((seen[0] as { type?: string } | undefined)?.type).toBe("ship.resumed");
    await flushPipeline();
    // the adopted session is never archived by the attach handle
    expect(vi.mocked(archiveOwned)).not.toHaveBeenCalled();
  });

  test("a failed attach (open fails, no terminal history) does not archive the adopted session", async () => {
    vi.mocked(listEvents).mockResolvedValue([]);
    vi.mocked(openStream).mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));
    const handle = await new CloudClaudeRunner().attach({
      agentId: "ses-1",
      runId: "ses-1",
      model: { id: "claude-sonnet-4-6" },
      onEvent: () => undefined,
    });
    const result = await handle.result;
    expect(result.status).toBe("failed");
    await flushPipeline();
    // this handle did not create the session, so cleanup must not archive it
    expect(vi.mocked(archiveOwned)).not.toHaveBeenCalled();
  });
});

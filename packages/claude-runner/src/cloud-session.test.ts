/**
 * Tests for `cloud-session.ts` — SDK seam.
 * Uses a plain mock client object; no `vi.mock("@anthropic-ai/sdk")` needed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type {
  CloudClient,
  CloudListedEvent,
  CloudStreamEvent,
  EnsureResult,
} from "./cloud-session.js";

import {
  archiveOwned,
  archiveSession,
  buildClient,
  createSession,
  dispatch,
  ensureAgent,
  ensureEnvironment,
  interruptAndArchive,
  interruptSession,
  listEvents,
  loggableSessionSpec,
  openStream,
  readGitHubToken,
} from "./cloud-session.js";

// Build a minimal mock CloudClient from named spies.
interface MockClientOptions {
  envCreate?: () => Promise<{ id: string }>;
  envArchive?: () => Promise<void>;
  agentCreate?: () => Promise<{ id: string }>;
  agentArchive?: () => Promise<void>;
  sessionCreate?: () => Promise<{ id: string }>;
  sessionArchive?: () => Promise<void>;
  eventsSend?: () => Promise<void>;
  eventsStream?: () => Promise<AsyncIterable<CloudStreamEvent>>;
  eventsList?: () => AsyncIterable<CloudListedEvent>;
}

// Concrete key set (not a string index signature) so `spies["envCreate"]` is a
// known, defined property under `noUncheckedIndexedAccess` — a bare
// `Record<string, ...>` would type each access as possibly-undefined.
type ClientSpies = Record<
  | "envCreate"
  | "envArchive"
  | "agentCreate"
  | "agentArchive"
  | "sessionCreate"
  | "sessionArchive"
  | "eventsSend"
  | "eventsStream"
  | "eventsList",
  ReturnType<typeof vi.fn>
>;

function orDefault<T>(provided: T | undefined, fallback: T): T {
  return provided ?? fallback;
}

function makeMockClient(opts: MockClientOptions = {}): {
  client: CloudClient;
  spies: ClientSpies;
} {
  const envCreateSpy = vi.fn(
    orDefault(opts.envCreate, () => Promise.resolve({ id: "env-test-001" })),
  );
  const envArchiveSpy = vi.fn(orDefault(opts.envArchive, () => Promise.resolve()));
  const agentCreateSpy = vi.fn(
    orDefault(opts.agentCreate, () => Promise.resolve({ id: "agt-test-001" })),
  );
  const agentArchiveSpy = vi.fn(orDefault(opts.agentArchive, () => Promise.resolve()));
  const sessionCreateSpy = vi.fn(
    orDefault(opts.sessionCreate, () => Promise.resolve({ id: "ses-test-001" })),
  );
  const sessionArchiveSpy = vi.fn(orDefault(opts.sessionArchive, () => Promise.resolve()));
  const eventsSendSpy = vi.fn(orDefault(opts.eventsSend, () => Promise.resolve()));

  // Default stream returns an empty async iterable.
  const eventsStreamSpy = vi.fn(
    orDefault(opts.eventsStream, () =>
      Promise.resolve(
        (async function* (): AsyncIterable<CloudStreamEvent> {
          // empty
        })(),
      ),
    ),
  );

  // Default list returns an empty async iterable.
  const eventsListSpy = vi.fn(
    orDefault(
      opts.eventsList,
      (): AsyncIterable<CloudListedEvent> =>
        (async function* (): AsyncIterable<CloudListedEvent> {
          // empty
        })(),
    ),
  );

  const client = {
    beta: {
      environments: { create: envCreateSpy, archive: envArchiveSpy },
      agents: { create: agentCreateSpy, archive: agentArchiveSpy },
      sessions: {
        create: sessionCreateSpy,
        archive: sessionArchiveSpy,
        events: {
          send: eventsSendSpy,
          stream: eventsStreamSpy,
          list: eventsListSpy,
        },
      },
    },
  } as unknown as CloudClient;

  return {
    client,
    spies: {
      envCreate: envCreateSpy,
      envArchive: envArchiveSpy,
      agentCreate: agentCreateSpy,
      agentArchive: agentArchiveSpy,
      sessionCreate: sessionCreateSpy,
      sessionArchive: sessionArchiveSpy,
      eventsSend: eventsSendSpy,
      eventsStream: eventsStreamSpy,
      eventsList: eventsListSpy,
    },
  };
}

describe("buildClient", () => {
  test("constructs without throwing; returns a CloudClient-shaped object", () => {
    const client = buildClient("sk-test-key");
    // The returned object must have at least the beta.sessions surface the runner calls.
    expect(client).toBeDefined();
    expect(typeof (client as unknown as { beta: unknown }).beta).toBe("object");
  });

  test("accepts optional baseUrl without throwing", () => {
    expect(() => buildClient("sk-test-key", "https://api.example.com")).not.toThrow();
  });
});

describe("readGitHubToken", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("reads GH_TOKEN when set", () => {
    vi.stubEnv("GH_TOKEN", "ghp_primary_token");
    expect(readGitHubToken()).toBe("ghp_primary_token");
  });

  test("falls back to GITHUB_TOKEN when GH_TOKEN is empty", () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "ghp_fallback_token");
    expect(readGitHubToken()).toBe("ghp_fallback_token");
  });

  test("returns undefined when both are empty", () => {
    expect(readGitHubToken()).toBeUndefined();
  });

  test("GH_TOKEN takes precedence over GITHUB_TOKEN when both set", () => {
    vi.stubEnv("GH_TOKEN", "ghp_primary");
    vi.stubEnv("GITHUB_TOKEN", "ghp_secondary");
    expect(readGitHubToken()).toBe("ghp_primary");
  });
});

describe("ensureEnvironment", () => {
  test("returns existing environmentId without calling create", async () => {
    const { client, spies } = makeMockClient();
    const result: EnsureResult = await ensureEnvironment(client, {
      runId: "run-001",
      environmentId: "env-existing-123",
    });
    expect(result).toEqual({ id: "env-existing-123", owned: false });
    expect(spies.envCreate).not.toHaveBeenCalled();
  });

  test("creates a new environment when environmentId is not provided", async () => {
    const { client, spies } = makeMockClient({
      envCreate: () => Promise.resolve({ id: "env-new-456" }),
    });
    const result: EnsureResult = await ensureEnvironment(client, { runId: "run-001" });
    expect(result).toEqual({ id: "env-new-456", owned: true });
    expect(spies.envCreate).toHaveBeenCalledOnce();
  });

  test("creates env with name: ship/<runId>", async () => {
    const { client, spies } = makeMockClient();
    await ensureEnvironment(client, { runId: "wf-run-xyz" });
    const callArg = vi.mocked(spies.envCreate).mock.calls[0]?.[0] as { name?: string };
    expect(callArg.name).toBe("ship/wf-run-xyz");
  });
});

describe("ensureAgent", () => {
  test("returns existing agentId without calling create", async () => {
    const { client, spies } = makeMockClient();
    const result: EnsureResult = await ensureAgent(client, {
      runId: "run-001",
      agentId: "agt-existing-123",
      modelId: "claude-opus-4-5",
    });
    expect(result).toEqual({ id: "agt-existing-123", owned: false });
    expect(spies.agentCreate).not.toHaveBeenCalled();
  });

  test("creates a new agent when agentId is not provided", async () => {
    const { client, spies } = makeMockClient({
      agentCreate: () => Promise.resolve({ id: "agt-new-789" }),
    });
    const result: EnsureResult = await ensureAgent(client, {
      runId: "run-001",
      modelId: "claude-opus-4-5",
    });
    expect(result).toEqual({ id: "agt-new-789", owned: true });
    expect(spies.agentCreate).toHaveBeenCalledOnce();
  });

  test("creates agent with name: ship/<runId> and correct model", async () => {
    const { client, spies } = makeMockClient();
    await ensureAgent(client, { runId: "wf-run-abc", modelId: "claude-sonnet-4-5" });
    const callArg = vi.mocked(spies.agentCreate).mock.calls[0]?.[0] as {
      name?: string;
      model?: string;
    };
    expect(callArg.name).toBe("ship/wf-run-abc");
    expect(callArg.model).toBe("claude-sonnet-4-5");
  });

  test("creates agent with agent_toolset_20260401 and always_allow policy", async () => {
    const { client, spies } = makeMockClient();
    await ensureAgent(client, { runId: "run-001", modelId: "claude-opus-4-5" });
    const callArg = vi.mocked(spies.agentCreate).mock.calls[0]?.[0] as {
      tools?: { type?: string; default_config?: { permission_policy?: { type?: string } } }[];
    };
    expect(callArg.tools?.[0]?.type).toBe("agent_toolset_20260401");
    expect(callArg.tools?.[0]?.default_config?.permission_policy?.type).toBe("always_allow");
  });
});

describe("createSession", () => {
  test("calls sessions.create with agent, environment_id, and resources", async () => {
    const { client, spies } = makeMockClient({
      sessionCreate: () => Promise.resolve({ id: "ses-001" }),
    });
    const sessionId = await createSession(client, {
      agentId: "agt-001",
      environmentId: "env-001",
      repoUrl: "https://github.com/acme/test",
      pat: "ghp_super_secret",
    });
    expect(sessionId).toBe("ses-001");
    const callArg = vi.mocked(spies.sessionCreate).mock.calls[0]?.[0] as {
      agent?: string;
      environment_id?: string;
      resources?: { authorization_token?: string; url?: string }[];
    };
    expect(callArg.agent).toBe("agt-001");
    expect(callArg.environment_id).toBe("env-001");
    expect(callArg.resources?.[0]?.url).toBe("https://github.com/acme/test");
    // PAT in payload — only the loggableSessionSpec redacts it; the wire call uses it.
    expect(callArg.resources?.[0]?.authorization_token).toBe("ghp_super_secret");
  });

  test("includes startingRef checkout when provided", async () => {
    const { client, spies } = makeMockClient();
    await createSession(client, {
      agentId: "agt-001",
      environmentId: "env-001",
      repoUrl: "https://github.com/acme/test",
      startingRef: "feature/my-branch",
      pat: "ghp_tok",
    });
    const resource = (
      vi.mocked(spies.sessionCreate).mock.calls[0]?.[0] as {
        resources?: { checkout?: { type?: string; name?: string } }[];
      }
    ).resources?.[0];
    expect(resource?.checkout).toEqual({ type: "branch", name: "feature/my-branch" });
  });

  test("omits checkout when startingRef is not provided", async () => {
    const { client, spies } = makeMockClient();
    await createSession(client, {
      agentId: "agt-001",
      environmentId: "env-001",
      repoUrl: "https://github.com/acme/test",
      pat: "ghp_tok",
    });
    const resource = (
      vi.mocked(spies.sessionCreate).mock.calls[0]?.[0] as {
        resources?: { checkout?: unknown }[];
      }
    ).resources?.[0];
    expect(resource).not.toHaveProperty("checkout");
  });
});

describe("dispatch", () => {
  test("sends a user.message event with the prompt text", async () => {
    const { client, spies } = makeMockClient();
    await dispatch(client, "ses-001", "implement the feature");
    const callArg = vi.mocked(spies.eventsSend).mock.calls[0] as [
      string,
      { events?: { type?: string; content?: { type?: string; text?: string }[] }[] },
    ];
    expect(callArg[0]).toBe("ses-001");
    expect(callArg[1].events?.[0]?.type).toBe("user.message");
    expect(callArg[1].events?.[0]?.content?.[0]?.text).toBe("implement the feature");
  });
});

describe("openStream", () => {
  test("calls events.stream and returns the async iterable", async () => {
    const fakeStream: AsyncIterable<CloudStreamEvent> = (async function* () {
      // empty
    })();
    const { client, spies } = makeMockClient({
      eventsStream: () => Promise.resolve(fakeStream),
    });
    const result = await openStream(client, "ses-001");
    expect(spies.eventsStream).toHaveBeenCalledWith(
      "ses-001",
      expect.objectContaining({ betas: expect.any(Array) as unknown }),
    );
    expect(result).toBe(fakeStream);
  });
});

describe("listEvents", () => {
  test("collects all events from the paginated list", async () => {
    const fakeEvents: CloudListedEvent[] = [
      { id: "evt-1", type: "agent.message" } as unknown as CloudListedEvent,
      { id: "evt-2", type: "session.status_idle" } as unknown as CloudListedEvent,
    ];
    const { client } = makeMockClient({
      eventsList: () =>
        (async function* () {
          await Promise.resolve();
          yield fakeEvents[0]!;
          yield fakeEvents[1]!;
        })(),
    });
    const result = await listEvents(client, "ses-001");
    expect(result).toHaveLength(2);
    expect((result[0] as { id?: string }).id).toBe("evt-1");
    expect((result[1] as { id?: string }).id).toBe("evt-2");
  });

  test("returns empty array when no events", async () => {
    const { client } = makeMockClient();
    const result = await listEvents(client, "ses-001");
    expect(result).toEqual([]);
  });
});

describe("interruptSession", () => {
  test("sends a user.interrupt event", async () => {
    const { client, spies } = makeMockClient();
    await interruptSession(client, "ses-001");
    const callArg = vi.mocked(spies.eventsSend).mock.calls[0] as [
      string,
      { events?: { type?: string }[] },
    ];
    expect(callArg[0]).toBe("ses-001");
    expect(callArg[1].events?.[0]?.type).toBe("user.interrupt");
  });

  test("swallows errors (best-effort)", async () => {
    const { client } = makeMockClient({
      eventsSend: () => Promise.reject(new Error("interrupt failed")),
    });
    await expect(interruptSession(client, "ses-001")).resolves.toBeUndefined();
  });
});

describe("archiveSession", () => {
  test("calls sessions.archive", async () => {
    const { client, spies } = makeMockClient();
    await archiveSession(client, "ses-001");
    expect(spies.sessionArchive).toHaveBeenCalledWith(
      "ses-001",
      expect.objectContaining({ betas: expect.any(Array) as unknown }),
    );
  });

  test("swallows errors (best-effort)", async () => {
    const { client } = makeMockClient({
      sessionArchive: () => Promise.reject(new Error("archive failed")),
    });
    await expect(archiveSession(client, "ses-001")).resolves.toBeUndefined();
  });
});

describe("interruptAndArchive", () => {
  test("sends interrupt then archives", async () => {
    const { client, spies } = makeMockClient();
    await interruptAndArchive(client, "ses-001");
    expect(spies.eventsSend).toHaveBeenCalledOnce();
    expect(spies.sessionArchive).toHaveBeenCalledOnce();
  });
});

describe("archiveOwned", () => {
  test("always archives the session", async () => {
    const { client, spies } = makeMockClient();
    await archiveOwned(client, {
      sessionId: "ses-001",
      ownedAgent: false,
      ownedEnv: false,
    });
    expect(spies.sessionArchive).toHaveBeenCalledOnce();
    expect(spies.agentArchive).not.toHaveBeenCalled();
    expect(spies.envArchive).not.toHaveBeenCalled();
  });

  test("archives owned agent when ownedAgent is true and agentId provided", async () => {
    const { client, spies } = makeMockClient();
    await archiveOwned(client, {
      sessionId: "ses-001",
      agentId: "agt-001",
      ownedAgent: true,
      ownedEnv: false,
    });
    expect(spies.agentArchive).toHaveBeenCalledWith(
      "agt-001",
      expect.objectContaining({ betas: expect.any(Array) as unknown }),
    );
  });

  test("does not archive agent when ownedAgent is false", async () => {
    const { client, spies } = makeMockClient();
    await archiveOwned(client, {
      sessionId: "ses-001",
      agentId: "agt-001",
      ownedAgent: false,
      ownedEnv: false,
    });
    expect(spies.agentArchive).not.toHaveBeenCalled();
  });

  test("archives owned environment when ownedEnv is true and environmentId provided", async () => {
    const { client, spies } = makeMockClient();
    await archiveOwned(client, {
      sessionId: "ses-001",
      environmentId: "env-001",
      ownedAgent: false,
      ownedEnv: true,
    });
    expect(spies.envArchive).toHaveBeenCalledWith(
      "env-001",
      expect.objectContaining({ betas: expect.any(Array) as unknown }),
    );
  });

  test("swallows agent archive errors (best-effort)", async () => {
    const { client } = makeMockClient({
      agentArchive: () => Promise.reject(new Error("agent archive failed")),
    });
    await expect(
      archiveOwned(client, {
        sessionId: "ses-001",
        agentId: "agt-001",
        ownedAgent: true,
        ownedEnv: false,
      }),
    ).resolves.toBeUndefined();
  });

  test("swallows env archive errors (best-effort)", async () => {
    const { client } = makeMockClient({
      envArchive: () => Promise.reject(new Error("env archive failed")),
    });
    await expect(
      archiveOwned(client, {
        sessionId: "ses-001",
        environmentId: "env-001",
        ownedAgent: false,
        ownedEnv: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("loggableSessionSpec", () => {
  test("redacts authorization_token", () => {
    const spec = {
      agentId: "agt-001",
      environmentId: "env-001",
      repoUrl: "https://github.com/acme/test",
      startingRef: "main",
    };
    const loggable = loggableSessionSpec(spec) as {
      authorization_token?: unknown;
      agentId?: string;
    };
    expect(loggable.authorization_token).toBe("[redacted]");
    expect(loggable.agentId).toBe("agt-001");
  });

  test("omits startingRef when not provided", () => {
    const spec = {
      agentId: "agt-001",
      environmentId: "env-001",
      repoUrl: "https://github.com/acme/test",
    };
    const loggable = loggableSessionSpec(spec) as { startingRef?: unknown };
    expect(loggable).not.toHaveProperty("startingRef");
  });
});

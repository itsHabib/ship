/**
 * SDK seam for `@anthropic-ai/sdk` (Managed Agents beta).
 * Only this file imports `@anthropic-ai/sdk` — the import-isolation test enforces it.
 * Pure mechanism: no policy decisions, no per-run state.
 */

import type {
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsMCPToolsetParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type {
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

import Anthropic from "@anthropic-ai/sdk";

// Re-exported for use in cloud-runner.ts / cloud-terminal-map.ts without
// those files needing a direct import from @anthropic-ai/sdk.
export type CloudStreamEvent = BetaManagedAgentsStreamSessionEvents;
export type CloudListedEvent = BetaManagedAgentsSessionEvent;
export type CloudErrorEvent = BetaManagedAgentsSessionErrorEvent;
export type CloudClient = Anthropic;

const BETAS = ["managed-agents-2026-04-01"];
const GH_TOKEN_ENVS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
const GH_MCP_URL_ENV = "GITHUB_MCP_URL";

/**
 * MCP-server name for the injected GitHub remote MCP. Referenced by the
 * `mcp_toolset` on the agent's `tools` (Managed Agents rejects an unreferenced
 * `mcp_servers` entry at create) and matched against `agent.mcp_tool_use`
 * events during branch reconstruction.
 */
export const GITHUB_MCP_SERVER_NAME = "github";

/**
 * The GitHub remote-MCP endpoint URL, from `GITHUB_MCP_URL` (wiring, not the
 * per-task input — it may carry an auth token). Undefined when unset: the agent
 * then pushes the branch via the mounted repo's PAT and the `gh` fallback
 * reconstructs the PR. `URLMCPServerParams` has no auth-header field, so the GH
 * PAT must ride in the URL or a session vault (resolved at L4).
 */
export function readGitHubMcpUrl(): string | undefined {
  const val = process.env[GH_MCP_URL_ENV];
  return val !== undefined && val !== "" ? val : undefined;
}

type AgentTool = BetaManagedAgentsAgentToolset20260401Params | BetaManagedAgentsMCPToolsetParams;

// The always-on base toolset (file edit / bash / etc.), plus — when a GitHub MCP
// URL is wired — the remote GitHub MCP server and the `mcp_toolset` that
// references it (required, else create rejects the unreferenced server).
function buildAgentTools(githubMcpUrl: string | undefined): AgentTool[] {
  const tools: AgentTool[] = [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
    },
  ];
  if (githubMcpUrl === undefined) return tools;
  tools.push({
    type: "mcp_toolset",
    mcp_server_name: GITHUB_MCP_SERVER_NAME,
    default_config: { enabled: true, permission_policy: { type: "always_allow" } },
  });
  return tools;
}

// SECURITY (resolved at L4): `URLMCPServerParams` carries no auth-header field,
// so any credential must ride in the URL itself — and this `url` is sent in the
// `agents.create` request body, where a token-bearing URL would surface in
// Anthropic API logs / error payloads in plaintext. L4 must pick a non-leaking
// delivery (server-side session vault, short-lived scoped token, or a proxy that
// injects auth) before the token-bearing path ships. Until then, prefer a
// GITHUB_MCP_URL whose auth is managed by the MCP endpoint operator, not embedded.
function buildMcpServers(
  githubMcpUrl: string | undefined,
): BetaManagedAgentsURLMCPServerParams[] | undefined {
  if (githubMcpUrl === undefined) return undefined;
  return [{ name: GITHUB_MCP_SERVER_NAME, type: "url", url: githubMcpUrl }];
}

export function buildClient(apiKey: string, baseUrl?: string): CloudClient {
  return new Anthropic({
    apiKey,
    ...(baseUrl !== undefined && { baseURL: baseUrl }),
  });
}

export function readGitHubToken(): string | undefined {
  for (const key of GH_TOKEN_ENVS) {
    const val = process.env[key];
    if (val !== undefined && val !== "") return val;
  }
  return undefined;
}

export interface EnsureResult {
  readonly id: string;
  readonly owned: boolean;
}

export async function ensureEnvironment(
  client: CloudClient,
  spec: { readonly runId: string; readonly environmentId?: string },
): Promise<EnsureResult> {
  if (spec.environmentId !== undefined) {
    return { id: spec.environmentId, owned: false };
  }
  const env = await client.beta.environments.create({
    name: `ship/${spec.runId}`,
    config: { type: "cloud" },
    betas: BETAS,
  });
  return { id: env.id, owned: true };
}

export async function ensureAgent(
  client: CloudClient,
  spec: {
    readonly runId: string;
    readonly agentId?: string;
    readonly modelId: string;
    readonly system?: string;
    /** GitHub remote-MCP endpoint; when set, wires the server + its `mcp_toolset`. */
    readonly githubMcpUrl?: string;
  },
): Promise<EnsureResult> {
  if (spec.agentId !== undefined) {
    return { id: spec.agentId, owned: false };
  }
  const mcpServers = buildMcpServers(spec.githubMcpUrl);
  const agent = await client.beta.agents.create({
    model: spec.modelId,
    name: `ship/${spec.runId}`,
    ...(spec.system !== undefined && { system: spec.system }),
    ...(mcpServers !== undefined && { mcp_servers: mcpServers }),
    tools: buildAgentTools(spec.githubMcpUrl),
    betas: BETAS,
  });
  return { id: agent.id, owned: true };
}

export async function createSession(
  client: CloudClient,
  spec: {
    readonly agentId: string;
    readonly environmentId: string;
    readonly repoUrl: string;
    readonly startingRef?: string;
    readonly pat: string;
  },
): Promise<string> {
  const session = await client.beta.sessions.create({
    agent: spec.agentId,
    environment_id: spec.environmentId,
    resources: [
      {
        type: "github_repository",
        url: spec.repoUrl,
        authorization_token: spec.pat,
        ...(spec.startingRef !== undefined && {
          checkout: { type: "branch", name: spec.startingRef },
        }),
      },
    ],
    betas: BETAS,
  });
  return session.id;
}

export async function dispatch(
  client: CloudClient,
  sessionId: string,
  prompt: string,
): Promise<void> {
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: prompt }],
      },
    ],
    betas: BETAS,
  });
}

export async function openStream(
  client: CloudClient,
  sessionId: string,
): Promise<AsyncIterable<CloudStreamEvent>> {
  return client.beta.sessions.events.stream(sessionId, { betas: BETAS });
}

export async function listEvents(
  client: CloudClient,
  sessionId: string,
): Promise<CloudListedEvent[]> {
  const events: CloudListedEvent[] = [];
  for await (const ev of client.beta.sessions.events.list(sessionId, { betas: BETAS })) {
    events.push(ev);
  }
  return events;
}

export async function interruptSession(client: CloudClient, sessionId: string): Promise<void> {
  try {
    await client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.interrupt" }],
      betas: BETAS,
    });
  } catch {
    /* swallow — best-effort interrupt */
  }
}

export async function archiveSession(client: CloudClient, sessionId: string): Promise<void> {
  // Setup-failure cleanup may pass "" before a session was created — skip the
  // guaranteed-to-fail archive call rather than relying on the catch.
  if (sessionId === "") return;
  try {
    await client.beta.sessions.archive(sessionId, { betas: BETAS });
  } catch {
    /* swallow — best-effort archive */
  }
}

export async function interruptAndArchive(client: CloudClient, sessionId: string): Promise<void> {
  await interruptSession(client, sessionId);
  await archiveSession(client, sessionId);
}

export async function archiveOwned(
  client: CloudClient,
  spec: {
    readonly sessionId: string;
    readonly agentId?: string;
    readonly environmentId?: string;
    readonly ownedAgent: boolean;
    readonly ownedEnv: boolean;
  },
): Promise<void> {
  await archiveSession(client, spec.sessionId);
  if (spec.ownedAgent && spec.agentId !== undefined) {
    try {
      await client.beta.agents.archive(spec.agentId, { betas: BETAS });
    } catch {
      /* swallow */
    }
  }
  if (spec.ownedEnv && spec.environmentId !== undefined) {
    try {
      await client.beta.environments.archive(spec.environmentId, { betas: BETAS });
    } catch {
      /* swallow */
    }
  }
}

// Redacts the authorization_token and other secrets from log-safe payload view.
export function loggableSessionSpec(spec: {
  readonly agentId: string;
  readonly environmentId: string;
  readonly repoUrl: string;
  readonly startingRef?: string;
}): unknown {
  return {
    agentId: spec.agentId,
    environmentId: spec.environmentId,
    repoUrl: spec.repoUrl,
    ...(spec.startingRef !== undefined && { startingRef: spec.startingRef }),
    authorization_token: "[redacted]",
  };
}

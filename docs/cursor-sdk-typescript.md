# Cursor TypeScript SDK — Reference

> Local cache of the official `@cursor/sdk` TypeScript reference. Source: <https://cursor.com/docs/sdk/typescript> (fetched 2026-05-05).
> Use this as the single source of truth when designing Ship's `cursor-runner` package. Re-fetch the source if the SDK seems to have moved on.

## Why this doc exists

We're designing Ship around the Cursor SDK as the implementation backend. This file is the ground truth for SDK behavior; the V1 spec ([docs/features/ship-v1/spec.md](features/ship-v1/spec.md)) cites it for runner-shape decisions.

## Install + auth

```bash
npm install @cursor/sdk
export CURSOR_API_KEY="your-key"
```

Key types accepted:

- User API keys — Cursor Dashboard → Integrations.
- Service account keys — Team settings.
- Team Admin keys — **not yet supported** (limitation).

## Mental model — three concepts

| Concept | Purpose |
|---|---|
| `Agent` | Container holding conversation state, workspace config, settings across multiple prompts. |
| `Run` | A single prompt submission. Has its own stream, status, result, cancellation. |
| `SDKMessage` | Normalized stream events emitted during a run. |

An agent can have many runs over its lifetime. Runs are the unit of work; agents are the unit of context.

## Quick start

```typescript
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Summarize what this repository does");

for await (const event of run.stream()) {
  console.log(event);
}
```

## Local vs cloud runtime

Runtime is decided by which key is passed to `Agent.create`:

- **`local: { cwd, settingSources? }`** — runs inline in the Node process; touches files on disk.
  - Best for: dev scripts, CI, "run this in the worktree I just made."
- **`cloud: { env, repos, autoCreatePR, ... }`** — Cursor-hosted VM clones the repo and runs there.
  - Best for: parallel agents, long-running tasks, agents that should survive disconnects.
- **Self-hosted cloud** — same shape as cloud, you manage the VM pool.

Agents are addressable across runtimes via ID prefix: `bc-` = cloud, otherwise local.

## `Agent.create()` — full options

```typescript
await Agent.create({
  apiKey: string,                    // or fall back to CURSOR_API_KEY
  model: ModelSelection,             // required for local; cloud has a default
  name?: string,
  agentId?: string,
  local?: { cwd?: string | string[]; settingSources?: SettingSource[] },
  cloud?: CloudOptions,
  mcpServers?: Record<string, McpServerConfig>,
  agents?: Record<string, AgentDefinition>,  // <-- subagents
});
```

```typescript
type CloudOptions = {
  env?: { type: "cloud" | "pool" | "machine"; name?: string };  // default: cloud
  repos?: Array<{ url: string; startingRef?: string; prUrl?: string }>;
  workOnCurrentBranch?: boolean;     // push to existing branch instead of new
  autoCreatePR?: boolean;            // open a PR when the run finishes
  skipReviewerRequest?: boolean;     // don't request the calling user as reviewer
  envVars?: Record<string, string>;  // short-lived session env
};

type SettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all";
```

## Sending messages

```typescript
const run = await agent.send("Find the bug in src/auth.ts");

// With images
const run = await agent.send({
  text: "What's in this screenshot?",
  images: [{ data: base64Png, mimeType: "image/png" }],
});

// With per-run model override (sticky for that run)
const run = await agent.send("Plan the refactor", {
  model: { id: "composer-2.5" },
});
```

Per-send options:

| Property | Type | Purpose |
|---|---|---|
| `model` | `ModelSelection` | Override agent's model for this run (sticky) |
| `mcpServers` | `Record<string, McpServerConfig>` | Replace inline servers for this run |
| `onStep` | `(args) => void \| Promise<void>` | Callback after each conversation step |
| `onDelta` | `(args) => void \| Promise<void>` | Callback per raw interaction update |
| `local.force` | `boolean` | Local only: expire stuck active run before starting |

## The `Run` interface

```typescript
interface Run {
  readonly id: string;
  readonly agentId: string;
  readonly status: "running" | "finished" | "error" | "cancelled";
  readonly result?: string;
  readonly model?: ModelSelection;
  readonly durationMs?: number;

  stream(): AsyncGenerator<SDKMessage, void>;
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
  conversation(): Promise<ConversationTurn[]>;
  supports(operation: RunOperation): boolean;
  unsupportedReason(operation: RunOperation): string | undefined;
  onDidChangeStatus(listener: (status: RunStatus) => void): () => void;
}
```

```typescript
interface RunResult {
  id: string;
  status: "finished" | "error" | "cancelled";
  result?: string;             // final assistant text
  model?: ModelSelection;
  durationMs?: number;
  git?: { branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }> };
}
```

`result.git.branches` is how cloud runs surface the branch/PR they produced. Local runs do not populate this — Ship has to discover branch/PR via the worktree itself or `gh`.

## Streaming events

```typescript
for await (const event of run.stream()) {
  switch (event.type) {
    case "system":     // init metadata: model, tools
    case "user":       // echo of user prompt
    case "assistant":  // model text + tool_use blocks
    case "thinking":   // reasoning content
    case "tool_call":  // tool invocation; status: running | completed | error
    case "status":     // cloud lifecycle: CREATING | RUNNING | FINISHED | ERROR | CANCELLED | EXPIRED
    case "task":       // task-level milestones
    case "request":    // awaiting user input/approval
  }
}
```

```typescript
type SDKMessage =
  | SDKSystemMessage      // { type, subtype?, agent_id, run_id, model?, tools? }
  | SDKUserMessageEvent   // { type, agent_id, run_id, message: { role: "user", content: TextBlock[] } }
  | SDKAssistantMessage   // { type, agent_id, run_id, message: { role: "assistant", content: (TextBlock|ToolUseBlock)[] } }
  | SDKThinkingMessage    // { type, agent_id, run_id, text, thinking_duration_ms? }
  | SDKToolUseMessage     // { type, agent_id, run_id, call_id, name, status, args?, result?, truncated? }
  | SDKStatusMessage      // { type, agent_id, run_id, status, message? }
  | SDKTaskMessage        // { type, agent_id, run_id, status?, text? }
  | SDKRequestMessage;    // { type, agent_id, run_id, request_id }
```

> **Important:** the `args`/`result` payloads on `tool_call` events are NOT a stable schema. Treat as `unknown` and parse defensively. The envelope (`type`, `call_id`, `name`, `status`) is stable.

### `onDelta` (raw interaction updates)

For finer granularity than `stream()`:

```typescript
type InteractionUpdate =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-completed"; thinkingDurationMs: number }
  | { type: "tool-call-started"; callId; toolCall; modelCallId }
  | { type: "partial-tool-call"; callId; toolCall; modelCallId }
  | { type: "tool-call-completed"; callId; toolCall; modelCallId }
  | { type: "token-delta"; tokens: number }
  | { type: "step-started"; stepId: number }
  | { type: "step-completed"; stepId; stepDurationMs: number }
  | { type: "turn-ended"; usage?: { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens } }
  | { type: "user-message-appended"; userMessage }
  | { type: "summary"; summary: string }
  | { type: "summary-started" }
  | { type: "summary-completed" }
  | { type: "shell-output-delta"; event: Record<string, unknown> };
```

### Wait / cancel / status listener

```typescript
const result = await run.wait();      // resolve when finished/error/cancelled
await run.cancel();                   // status -> "cancelled"; partial output retained
const stop = run.onDidChangeStatus(s => console.log(s));
stop();                               // remove listener
```

## One-shot helper

```typescript
const result = await Agent.prompt("What does the auth middleware do?", {
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});
// creates agent, sends prompt, waits, disposes — returns RunResult
```

## Lifecycle

```typescript
// Automatic disposal
await using agent = await Agent.create({ /* ... */ });

// Manual disposal
await agent[Symbol.asyncDispose]();
agent.close();        // fire-and-forget

// Re-read filesystem config (hooks, MCP, subagents) without disposing
await agent.reload();
```

## Resuming + listing + inspecting

```typescript
// Resume by ID (runtime auto-detected from prefix)
const agent = await Agent.resume("bc-abc123", { apiKey });

// List agents
await Agent.list({ runtime: "local", cwd, limit?, cursor? });
await Agent.list({ runtime: "cloud", prUrl?, includeArchived? });

// Get one
await Agent.get("agent-id", { cwd?, apiKey? });

// List runs for an agent
await Agent.listRuns("agent-id", { runtime: "local", cwd?, limit?, cursor? });

// Get a single run
await Agent.getRun("run-id", { runtime: "local", cwd? });
await Agent.getRun("run-id", { runtime: "cloud", agentId: "bc-..." });  // cloud needs parent

// Cloud lifecycle
await Agent.archive(agentId);
await Agent.unarchive(agentId);
await Agent.delete(agentId);  // permanent
```

> **Resume gotcha:** `agent.model` is undefined after resume unless passed again. Inline `mcpServers` are NOT persisted across resume — re-pass them or use file-based `.cursor/mcp.json`.

## Models

```typescript
interface ModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

// Discover available models + parameter grids — the per-model param surface
// evolves (e.g. as of 2026-05-23, `composer-2` no longer accepts a `thinking`
// param; current composer variants expose `fast`). Always call this to find
// the live shape rather than assuming a hard-coded grid.
const models = await Cursor.models.list({ apiKey? });
// Each item: { id, displayName, description?, parameters?, variants? }
```

## Account-level helpers (`Cursor` namespace)

```typescript
await Cursor.me({ apiKey? });              // { apiKeyName, userEmail?, createdAt }
await Cursor.models.list({ apiKey? });     // SDKModel[]
await Cursor.repositories.list({ apiKey? }); // cloud only
```

## MCP servers

Inline at agent creation OR per-send:

```typescript
const agent = await Agent.create({
  /* ... */
  mcpServers: {
    docs: {
      type: "http",
      url: "https://example.com/mcp",
      auth: { CLIENT_ID: "...", scopes: ["read", "write"] },
    },
    filesystem: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      cwd: process.cwd(),
    },
  },
});
```

```typescript
type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string,string>; cwd?: string }
  | { type?: "http" | "sse"; url: string; headers?: Record<string,string>;
      auth?: { CLIENT_ID: string; CLIENT_SECRET?: string; scopes?: string[] } };
```

**Local loading precedence:**
1. `mcpServers` on `agent.send()` (replaces creation-time)
2. `mcpServers` on `Agent.create()`
3. Plugin servers (if `settingSources` includes `"plugins"`)
4. Project servers from `.cursor/mcp.json` (if `settingSources` includes `"project"`)
5. User servers from `~/.cursor/mcp.json` (if `settingSources` includes `"user"`)

**Cloud loading:**
1. `mcpServers` on `agent.send()`
2. `mcpServers` on `Agent.create()`
3. User and team MCP servers from cursor.com/agents

## Subagents — the important part

Define named subagents that the main agent can spawn via the built-in `Agent` tool:

```typescript
const agent = await Agent.create({
  /* ... */
  agents: {
    "code-reviewer": {
      description: "Expert code reviewer for quality and security.",
      prompt: "Review code for bugs, security issues, and proven approaches.",
      model: "inherit",
    },
    "test-writer": {
      description: "Writes tests for code changes.",
      prompt: "Write comprehensive tests for the given code.",
    },
  },
});
```

```typescript
interface AgentDefinition {
  description: string;                        // when to use this subagent
  prompt: string;                              // its system prompt
  model?: ModelSelection | "inherit";          // default: "inherit"
  mcpServers?: Array<string | Record<string, McpServerConfig>>;
}
```

**File-based subagents:** put markdown files at `.cursor/agents/*.md` with frontmatter (name, description, optional model). Auto-loaded. Inline definitions override file-based ones with the same name.

**Implications for Ship.** Subagents are first-class composition primitives *inside the agent loop*. This means the orchestration that the original design doc proposed as outer recipes (Ship choreographs Cursor → Cursor → Cursor) can partially live *inside* a single Cursor agent that spawns subagents like `task-writer`, `code-reviewer`, `test-writer`. Two layers of composition exist:
- **Outer (Ship's job):** deterministic, durable chain across distinct workflow phases — implement / open PR / fix CI. Ship owns state, persistence, retries, escalation.
- **Inner (Cursor's job):** within one phase, the model-led decision of "ask the code-reviewer subagent for a second look before declaring done."

Don't put inner stuff into Ship recipes; don't put outer stuff into Cursor subagents.

## Hooks

File-based only — no programmatic callbacks. Local: `.cursor/hooks.json` (project) or `~/.cursor/hooks.json` (user). Cloud: commit `.cursor/hooks.json` to the repo.

## Artifacts (cloud only)

```typescript
interface SDKArtifact { path: string; sizeBytes: number; updatedAt: string; }

const artifacts = await agent.listArtifacts();
const buffer = await agent.downloadArtifact(artifacts[0].path);
```

Local agents return an empty list and throw on download.

## Conversation view

```typescript
const turns = await run.conversation();
// ConversationTurn[] — flat representation suitable for rendering or persistence
```

```typescript
type ConversationTurn =
  | { type: "agentConversationTurn"; turn: AgentConversationTurn }
  | { type: "shellConversationTurn"; turn: ShellConversationTurn };

interface AgentConversationTurn {
  userMessage?: { text: string };
  steps: Array<
    | { type: "assistantMessage"; message: { text: string } }
    | { type: "toolCall"; message: ToolCall }
    | { type: "thinkingMessage"; message: { text: string; thinkingDurationMs?: number } }
  >;
}

interface ShellConversationTurn {
  shellCommand?: { command: string; workingDirectory?: string };
  shellOutput?: { stdout: string; stderr: string; exitCode: number };
}
```

## Errors

All SDK errors extend `CursorAgentError` with `isRetryable`, `code`, `cause`, `protoErrorCode`.

| Error | When |
|---|---|
| `AuthenticationError` | Bad key, not logged in, insufficient permissions |
| `RateLimitError` | Too many requests / usage limits exceeded |
| `ConfigurationError` | Invalid model, bad params |
| `IntegrationNotConnectedError` | Cloud agent for repo with unconnected SCM (`provider`, `helpUrl`) |
| `NetworkError` | Service unavailable, timeout |
| `UnknownAgentError` | Unclassified |
| `UnsupportedRunOperationError` | Operation not allowed for this run; check `run.supports(op)` first |

## Limitations to design around

- Inline `mcpServers` not persisted across `Agent.resume()`.
- Artifact download unavailable for local agents.
- `local.settingSources` does not apply to cloud agents.
- Hooks are file-based only — no programmatic hook callbacks.
- Team Admin API keys not yet supported.
- Tool call `args`/`result` schemas are not stable — parse defensively.

## Billing

SDK runs follow IDE/Cloud-Agents pricing, request pools, and Privacy Mode rules. Spending appears in the team's usage dashboard under the SDK tag.

---

## What this means for Ship's design

A short list of corrections / refinements to apply when we write `docs/features/ship-v1/spec.md`:

1. **`CursorRunner` shape.** The provisional interface in the original design doc has `startRun / getRun / streamRun / waitRun / cancelRun / followUp`. Map onto SDK: `Agent.create + agent.send` (start), `Agent.getRun` (get), `run.stream()` (stream), `run.wait()` (wait), `run.cancel()` (cancel), `agent.send` again on the same agent (follow-up). The `followUp` primitive is just "another `send` on the same agent" — don't model it separately.

2. **Branch/PR discovery.** Cloud runs surface `result.git.branches` with `branch` + `prUrl`. Local runs do not. For local-first MVP, Ship discovers the branch via Tower (the worktree's branch) and opens the PR via `gh` after the run completes. Don't ask the agent to open the PR — the SDK's `cloud.autoCreatePR` only applies to cloud runs.

3. **Subagents change the recipes question.** The user pointed at this for a reason: Cursor's subagent system is a real composition primitive. Reframe:
   - **Outer recipe layer** (Ship): chain of distinct workflow phases — implement → open-PR → review → fix-ci. Deterministic, persisted, owned by Ship.
   - **Inner subagent layer** (Cursor): within one phase, the agent can spawn subagents (e.g., implementation phase calls `code-reviewer` subagent before declaring done).
   - Don't conflate. Subagents do not replace recipes; they make each recipe step richer.

4. **MCP integration.** Ship is itself an MCP server. A Cursor agent launched by Ship can be configured (via `mcpServers` at create time) to call Ship's own MCP tools — useful for `observe`, `publish_artifact`, `next_action` from inside a run. This is the bridge that makes the comm-layer thesis viable later.

5. **Persistence.** SDK doesn't persist inline MCP servers across resume. Ship has to either (a) persist its own MCP server config alongside the agent, or (b) use file-based `.cursor/mcp.json` in the worktree. Option (b) is simpler and matches the worktree-as-substrate model.

6. **Tool-call schema instability.** Don't store raw `args`/`result` payloads in any structured way; archive them as opaque NDJSON. Build derived views (e.g., "files changed") from the agent's own structured summary at the end of the run, not from tool call introspection.

7. **Cancellation / cleanup.** Use `await using` whenever a run is short-lived. For long-running ship runs, hold an explicit handle and dispose on workflow termination.

## Why cloud runtime matters (beyond "long-running tasks")

Each Cursor cloud agent runs in its own isolated VM with a **full desktop environment**. Agents have mouse + keyboard and can drive the desktop and browser — interacting with the software they're building the way a human developer would. This is broader than headless browser automation: anything with a GUI becomes testable inside the run.

Implications for Ship:

- For local runtime (V1), the equivalent is wiring an MCP server like `playwright-mcp` into the Cursor agent's `mcpServers`. The agent then drives a real (headless) browser running on the host. Ship will pass user-supplied MCP server configs through to `Agent.create` so this is supported on day one without Ship knowing about Playwright specifically.
- Cloud runtime is the upgrade: full GUI, not just browser. It's the natural V2 because UI-heavy task docs benefit disproportionately. Worth not deferring this further than necessary.
- Ship itself stays out of the loop here — it doesn't open browsers, doesn't render screenshots, doesn't host VMs. It just hands the right tooling to the agent and persists what comes back.

## Spike findings (run 1, 2026-05-06)

First end-to-end spike. Local runtime, `composer-2`, prompt: "List the top-level files in this directory and summarize what this project appears to be in 2-3 sentences. Do not modify any files." cwd = `spike/` itself. Took 67s, 119 events.

### Confirmed

- `Agent.create({ apiKey, model: { id }, local: { cwd } })` works as documented for local runtime.
- `agent.send(prompt)` returns immediately with a `Run`; `run.id` is `run-<uuid>`, `agent.agentId` is `agent-<uuid>` for local.
- `for await (const ev of run.stream())` iterates and terminates naturally on completion.
- `await run.wait()` returns `RunResult` with `id`, `status: "finished"`, `result`, `model`, `durationMs`.
- `Cursor.me({ apiKey })` returns `{ apiKeyName, userId, createdAt, userEmail, userFirstName, userLastName }`. Confirms auth.
- `Cursor.models.list({ apiKey })` returns 28 models. `default` (Auto) is at the top; `composer-2` is alive; recent Claude / GPT / Gemini / Grok / Kimi entries are present.
- Tool call `args` IS populated and structured today (e.g. `{ globPattern, targetDirectory }`, `{ path }`). Treat as `unknown` per design — the doc warned this is unstable.
- `pnpm` 10 blocks `sqlite3`'s native postinstall by default. `@cursor/sdk` pulls `sqlite3@5.1.7` transitively. Fix: `pnpm.onlyBuiltDependencies` allowlist with `sqlite3` (and likely `better-sqlite3`, `esbuild` for the eventual monorepo).

### Surprises

- **`RunResult.result` IS the final assistant text.** We do not need to scan events for the closing assistant message; it is exposed directly on the result. This simplifies Ship's `summary.md` extraction substantially — the structured-summary prompt template is optional, not load-bearing.
- **`RunResult.git` is omitted entirely when no branches exist** (not `git: { branches: [] }`, just absent). Local runs never populate it. Use `result.git?.branches?.[0]` and treat undefined as "no branch info."
- **No `system`, `user`, `task`, or `request` events fired in this run.** Only `assistant`, `thinking`, `tool_call`, `status` were observed. The doc lists all event types; some may only fire under specific conditions (init metadata, user-input requests) or may be filtered out by the SDK in this version. Ship's `cursor-runner` should not block on `system` for run init — the first `status: "RUNNING"` is the de-facto start signal.

### Event distribution (119 events / 67s)

| Type | Count | Notes |
|---|---:|---|
| `assistant` | 92 | One `text` block per event; deltas are tiny (~5–15 chars). |
| `tool_call` | 15 | `glob` ×1, `read` ×~5, `shell` ×~4, with running / completed pairs. |
| `thinking` | 10 | Also chunked into small text fragments. |
| `status` | 2 | `RUNNING` at start, `FINISHED` at end. |

### Untested

- **Cancellation.** Run completed naturally; SIGINT handler was not exercised. Next spike or first real `core` test should cover it.
- **`mcpServers` passthrough.** Not used in this spike.
- **Subagents** (`agents:` on `Agent.create`). Not used.
- **Cloud runtime.** Out of scope for V1.

### Implications for Ship V1

Updating these in `docs/features/ship-v1/spec.md`:

- **Open Q1 (default model):** lean toward `composer-2` for determinism in V1. `default` (Auto) is fine for users who don't care.
- **Open Q5 (structured summary parsing):** dropped from the critical path. Use `RunResult.result` directly as `summary.md`. The implementation prompt template can still ask for structured fields, but Ship doesn't need to parse them — they live inside `result` for humans.
- **`CursorRunner` event normalization:** keep the `SDKMessage` types directly. Don't synthesize `system` events if they don't fire.
- **Native deps:** the eventual root `package.json` needs `pnpm.onlyBuiltDependencies` covering `sqlite3`, `better-sqlite3`, and probably `esbuild`. Add a CI check that confirms `pnpm install` doesn't ignore any build scripts.
- **Confidence:** the SDK behaves close enough to the documented shape to scaffold against. Phase 1 (monorepo + tooling) can proceed.

## Re-fetch policy

This SDK is new. Re-fetch the source page if any of the following happen:
- A field referenced here doesn't exist on the installed `@cursor/sdk` version.
- New event types appear in `run.stream()` not in the table above.
- We're touching cloud-runtime features (the doc had less detail on cloud-only flows).

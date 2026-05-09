# Ship V1

Status: design draft. Not yet implemented.
Owner: itsHabib
Date: 2026-05-05
Last updated: 2026-05-05

## Summary

Ship V1 is the smallest end-to-end Ship that proves the core thesis: a task doc plus a repo plus the Cursor SDK can produce real changes in a real Tower worktree, with persistent state Ship owns. Nothing more. No PR opening. No review cycles. No CI repair. Those are V2+ phases that compose onto V1 without retroactively redesigning it.

The riskiest assumption in the entire Ship project is "the `@cursor/sdk` local runtime works the way the docs claim, and we can drive a useful end-to-end implementation run from a TypeScript host." V1 is the smallest experiment that answers that. Once V1 ships, the next phases are mechanical compositions on top: open a PR (`gh` shell-out), launch a review run (another `Agent.create + send`), fix CI (same shape, different prompt). They are not part of V1.

The user-facing verb is one tool: `ship` a task doc.

## Goals

- Take an approved task doc in a registered Tower repo and produce real, reviewable changes in a Tower worktree.
- Persist enough state that Ship can answer "what happened?" durably, after a restart, without the agent's stream still being held in memory.
- Establish the package boundaries (`workflow`, `mcp`, `store`, `tower-adapter`, `cursor-runner`, `core`, `mcp-server`, `cli`) so V2 phases attach without restructuring.
- Validate the Cursor SDK assumptions captured in `docs/cursor-sdk-typescript.md` against real behavior.

## Non-goals

V1 explicitly does not include any of:

- PR opening, comment management, review cycles, CI repair, merge readiness — V2.
- Cloud Cursor runtime — V2 at earliest. Local-only.
- Recipes, the recipe runner, recipe MCP tools — V2 at earliest.
- Communication-layer primitives (claims, decisions, handoffs, capability registry, observe/publish/route) — V2/V3.
- Dashboard or any web UI — out of scope, possibly never.
- Cross-repo coordination, multi-tenant features, hosted service — out of scope.
- Doc generation (`create_task_doc`) and doc review (`review_task_doc`) — V2.
- Subagent orchestration *from* Ship. Subagents declared on the Cursor agent are fine (they're SDK-native), but Ship does not add a layer above them in V1.

## Functional requirements

V1 must support these flows.

### F1 — Ship a task doc

Given:
- A repo registered with Tower.
- A task doc at a path inside that repo.

The user invokes (via MCP or CLI) `ship` with `repo` and `docPath`. Ship:

1. Validates that the repo is known to Tower and that `docPath` resolves to a file inside the repo's root.
2. Creates a new `WorkflowRun` row with status `pending`.
3. Asks Tower to create a worktree off `main` (worktree name derived from the doc slug; configurable via input).
4. Reads the task doc content from the worktree path (worktrees see the same docs once created).
5. Renders the implementation prompt (template below) and persists it as `prompt.md`.
6. Calls `Agent.create({ local: { cwd: worktree.path }, model, mcpServers? })`, then `agent.send(prompt)`.
7. Streams `SDKMessage` events to `events.ndjson` as they arrive.
8. On run completion, persists the structured `RunResult` as `result.json`.
9. Updates the `WorkflowRun` status to `succeeded`, `failed`, or `cancelled` based on the SDK result.
10. Returns the workflow run summary (id, status, worktree info, summary of changes, paths to artifacts).

The MCP tool returns once the run is complete. (Streaming responses are V2.)

### F2 — Inspect a workflow run

Given a workflow run ID, return durable state: status, repo, doc path, worktree info, started/ended times, the Cursor run summary, and paths to `prompt.md`, `events.ndjson`, `result.json`.

### F3 — List workflow runs

Filter by repo and status. Default: most-recent-first, limit 50.

### F4 — Cancel a running workflow

Given a workflow run ID for an in-flight run, cancel the Cursor run via `run.cancel()` and update status to `cancelled`. Idempotent.

### F5 — Cleanup is explicit, not automatic

V1 does NOT delete the worktree on completion. The worktree, the branch, and the changes remain for the user to inspect, push, and PR manually. (V2 will add `gh pr create` as its own composable phase; until then this is the user's job.)

## Non-functional requirements

- **Persistence is durable.** Restarting Ship between steps must not lose state. Every status transition is committed before returning.
- **Local-only.** No network calls except to the Cursor API and (transitively, via Tower) to git remotes.
- **No autonomous destructive actions.** Ship never deletes worktrees, force-pushes, or merges in V1.
- **Strict typing.** TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Zero `any`.
- **Strict lint.** ESLint + `@typescript-eslint/strict-type-checked` + `stylistic-type-checked`, complexity / max-lines / max-depth bounded to mirror the Go bar in `../tower/.golangci.yml`. CI fails on any lint or format issue.
- **Deterministic state transitions.** The state machine is in code, not in a prompt. The LLM is allowed to produce code; it is not allowed to decide whether the workflow is "done."
- **Single-process, single-user.** No locking, no concurrent run coordination across machines. One Ship daemon at a time.
- **Observable.** Every phase writes a structured summary; raw events are preserved as NDJSON; debugging a failed run means reading three files.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Data model | `WorkflowRun` row + auxiliary event NDJSON | Event-sourced ledger as the spine | Row is simpler to ship, easier to debug, and matches V1's single-actor reality. Migration to event-sourced is a V2 problem if we hit the multi-agent-publishing case. Documented in `CLAUDE.md`. |
| Runtime | Local Cursor only | Local + cloud from day one | Cloud adds repo-auth, polling, reconnect, and lifecycle complexity. Local-first matches the Tower worktree substrate exactly, and we have zero firsthand SDK experience to draw on for cloud. |
| PR opening | Out of scope for V1 | Wire `gh pr create` as the final V1 step | Keeps the scope honest. PR opening is a 30-line addition once V1 is real. Including it here makes V1 a multi-phase workflow before we've validated even one phase. |
| State location | Global SQLite + per-run filesystem dir | Per-repo `.ship/` mirroring `.git/` | One DB to query is simpler. Per-run files (prompt, events, result) live under a global runs dir keyed by run ID. We revisit if cross-repo coordination becomes a thing. |
| MCP tool surface | Three tools (`ship`, `get_workflow_run`, `list_workflow_runs`) | Six per markdown design §16.2 | Three matches V1's actual surface. The other three (`fix_ci`, `run_review_cycle`, `next_action`) require phases that don't exist yet. |
| Worktree cleanup | Never automatic | Auto-remove on success | The user wants to inspect changes and push manually. Auto-cleanup would also conflict with later PR/review phases that depend on the worktree still existing. |
| Implementation prompt | Template + task-doc body | Have Cursor draft its own implementation strategy | The prompt is the contract between Ship and the agent. Keep it explicit and version-controlled. |
| Configuration | YAML at `~/.config/ship/config.yaml` + env override | TOML / JSON / code | YAML matches the existing design doc and Habib's other projects. |

## Engineering decisions

### ED-1 — `WorkflowRun` is the primitive, not `Phase`

V1 has only one phase (implement), but the row schema admits a `phases` collection (FK'd by `workflow_run_id`). V2 phases (`pr_open`, `review`, `ci_fix`) become new rows in the same `phases` table — no schema migration to add them. The `WorkflowRun` status is computed as a function of the latest phase's outcome plus run-level overrides (cancelled, failed).

Rejected alternative: model V1 as a single flat run row. It would require migration the moment we add phase 2.

### ED-2 — Cursor runner abstracts the SDK; Ship core does not import `@cursor/sdk` directly

`packages/cursor-runner` is the only package that imports `@cursor/sdk`. It exports a `CursorRunner` interface and a default implementation. `packages/core` consumes the interface; tests of core use a fake runner exported from `cursor-runner/test/fake.ts`.

Cursor is the ONLY backend in V1. No backend-agnostic interface. If a second backend (e.g. Claude Code Agent SDK) is ever needed, we extract a generic interface at that point — not before. The interface today is named for what it is (`CursorRunner`), not for what it might become.

Why an interface at all (vs. a concrete class only):
- Test doubles. A fake runner for unit tests of `core` does not have to mock the SDK module.
- SDK upgrades stay isolated to the runner package.

The interface is designed against `docs/cursor-sdk-typescript.md`, not the Shipyard design doc's provisional shape.

### ED-3 — Tower adapter calls the Tower MCP server, not the CLI

Tower already exposes an MCP server. Ship's `tower-adapter` connects to it as an MCP client (over stdio). Reasons:
- Single source of truth for worktree state — no parallel parsing.
- Tower's MCP types are the contract; Ship subscribes to them.
- If Tower changes CLI flags, Ship doesn't break.

Fallback: if connecting to Tower MCP fails at startup, Ship surfaces a configuration error and exits. V1 does not implement a CLI fallback.

### ED-4 — Persistence layout

```
<UserConfigDir>/ship/
  config.yaml                       # global config
  state.db                          # SQLite — workflow_runs, phases, cursor_runs
  runs/
    <workflowRunId>/
      prompt.md                     # rendered implementation prompt
      task-doc.md                   # snapshot of the task doc at run start
      events.ndjson                 # raw SDK stream events
      result.json                   # RunResult from SDK
      summary.md                    # extracted structured summary (post-processed)
```

`<UserConfigDir>` resolves via the same logic Tower uses (APPDATA on Windows, XDG_CONFIG_HOME / HOME on Unix).

### ED-5 — Storage stack: Drizzle + better-sqlite3

Drizzle gives us TypeScript-first migrations and inferred row types from schema. `better-sqlite3` is synchronous, fast, and the standard pick for local-first Node apps.

Rejected: Prisma (heavier, codegen-driven), raw `node:sqlite` (too low-level for migrations).

### ED-6 — MCP transport: stdio

V1 ships only a stdio MCP server. SSE/HTTP can be added later by composing on top of the same tool registry.

### ED-7 — Naming

- Project: `ship`. Lowercase, single word. Repo: `itsHabib/ship`.
- Branches: `ship/<slug>`. Worktrees: same.
- Cursor agent name: `ship/<workflowRunId>`. Useful for `Agent.list` filtering.

## Architecture

### Package layout

```
ship/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .eslintrc.cjs
  .prettierrc
  Taskfile.yml                # task lint / task test / task check, like tower
  CLAUDE.md
  docs/
    cursor-sdk-typescript.md
    features/
      ship-v1/
        spec.md              # this file
        plan.md              # execution plan (companion)
  packages/
    workflow/                # Workflow entities + state machine + ID factories. No @ship/* deps.
    mcp/                     # MCP tool I/O schemas. Depends on @ship/workflow.
    store/                   # Drizzle + better-sqlite3 + migrations
    tower-adapter/           # MCP client to Tower
    cursor-runner/           # CursorRunner interface + @cursor/sdk impl
    core/                    # workflow service: ship(), getRun(), listRuns(), cancel()
    mcp-server/              # exposes core via MCP tools
    cli/                     # ship CLI invoking core
```

Dependency direction (strict, no cycles):

```
workflow → mcp
workflow → store
workflow → tower-adapter
workflow → cursor-runner
workflow, mcp → core
workflow, mcp → mcp-server
store, tower-adapter, cursor-runner → core
core → mcp-server
core → cli
```

`mcp-server` and `cli` never import each other. `core` never imports them.

### Component responsibilities

**`workflow`.** Zod schemas + inferred types for `WorkflowRun`, `Phase`, `CursorRunRef`, `WorktreeRef`, `WorkflowStatus`, `PhaseStatus`, `WorkflowPolicy`, `ModelSelection`. Plus state-machine helpers (`canTransition`, `isTerminal`), `DEFAULT_WORKFLOW_POLICY`, and the three ULID-prefixed ID factories. Pure types and validators; zero side effects. No `@ship/*` deps. Runtime deps: `zod`, `ulid`. See [phases/02-type-system.md](phases/02-type-system.md).

**`mcp`.** Zod schemas + inferred types for the four V1 MCP tool inputs and outputs (`shipInputSchema`, `shipOutputSchema`, `getWorkflowRunInput/OutputSchema`, etc.) plus the supporting `shipArtifactsSchema`. Embeds workflow entities by depending on `@ship/workflow` (workspace) for `WorkflowRun`, `WorktreeRef`, `CursorRunRef`, status enums, etc. Pure types; zero side effects. Runtime deps: `zod`, `@ship/workflow`. See [phases/02-type-system.md](phases/02-type-system.md).

**`store`.** SQLite persistence. Exports `createStore({ dbPath })` returning a `Store` interface with typed methods (`createWorkflowRun`, `updateStatus`, `appendPhase`, `getRun`, `listRuns`, `cancelRun`). Owns migrations. Does not own filesystem artifact paths — those are core's concern.

**`tower-adapter`.** Wraps an MCP stdio connection to Tower. Exports `TowerAdapter` interface: `getRepo(repo)`, `addWorktree({ repo, name, baseRef })`, `getWorktree({ repo, name })`, `removeWorktree({ repo, name })`. The two we actually use in V1 are `getRepo` and `addWorktree`. Wraps Tower's MCP types into `@ship/workflow` types (`WorktreeRef`, etc.) — Ship code never sees raw Tower MCP responses.

**`cursor-runner`.** Wraps `@cursor/sdk`, local runtime only. Exports the `CursorRunner` interface and a default implementation. A `FakeCursorRunner` is exported under `cursor-runner/test/fake.ts` for use by `core` tests. The package is the sole importer of `@cursor/sdk` in the monorepo.

**`core`.** Workflow service. Exports `createShipService({ store, tower, cursor, fs, clock, config })` returning a `ShipService` with methods `ship(input)`, `getRun(id)`, `listRuns(filter)`, `cancelRun(id)`. Holds the state machine and the artifact-write logic. Depends on the `CursorRunner` interface, not on its implementation. Does not import the MCP server or CLI; both depend on it.

**`mcp-server`.** Registers MCP tools (`ship`, `get_workflow_run`, `list_workflow_runs`, `cancel_workflow_run`) and an MCP resource (`ship://runs/{id}`). Tool handlers are thin: validate input with a `@ship/mcp` schema, call `ShipService` method, format output. Stdio only.

**`cli`.** Commander-based binary. Subcommands `ship`, `status`, `list`, `cancel`. Same `ShipService` instance. The CLI's `ship` subcommand is what we use during the spike before the MCP server even works.

## API boundaries / contracts

### MCP tools

```typescript
// ship
type ShipInput = {
  repo: string;            // Tower-registered repo name
  docPath: string;         // path relative to repo root
  worktreeName?: string;   // default: derived from doc slug
  baseRef?: string;        // default: main
  model?: string;          // default: from config
};

type ShipOutput = {
  workflowRunId: string;
  status: WorkflowStatus;
  worktree: WorktreeRef;
  cursorRun: CursorRunSummary;
  artifacts: { promptPath: string; eventsPath: string; resultPath: string };
  summary?: string;       // structured summary extracted from result
};

// get_workflow_run
type GetWorkflowRunInput = { workflowRunId: string };
type GetWorkflowRunOutput = WorkflowRun;

// list_workflow_runs
type ListWorkflowRunsInput = {
  repo?: string;
  status?: WorkflowStatus[];
  limit?: number;          // default 50, max 200
};
type ListWorkflowRunsOutput = { runs: WorkflowRun[] };

// cancel_workflow_run
type CancelWorkflowRunInput = { workflowRunId: string };
type CancelWorkflowRunOutput = { workflowRunId: string; status: WorkflowStatus };
```

### CLI

```bash
ship ship <docPath> [--repo <name>] [--worktree <name>] [--base <ref>] [--model <id>]
ship status <run_id>
ship list [--repo <name>] [--status <s,...>] [--limit <n>]
ship cancel <run_id>
```

Exit codes: 0 success, 1 user error, 2 internal error.

### Internal interfaces

```typescript
// cursor-runner/src/index.ts
import type { SDKMessage, ModelSelection, McpServerConfig } from "@cursor/sdk";

export interface CursorRunner {
  run(input: CursorRunInput): Promise<CursorRunHandle>;
}

export interface CursorRunInput {
  cwd: string;                                 // worktree path
  prompt: string;
  model: ModelSelection;
  mcpServers?: Record<string, McpServerConfig>;
  agentName?: string;                          // becomes Cursor agent name
  signal?: AbortSignal;                        // wired to run.cancel()
  onEvent: (event: SDKMessage) => void;        // called for every stream message
}

export interface CursorRunHandle {
  agentId: string;
  runId: string;
  result: Promise<CursorRunResult>;            // resolves when run finishes
  cancel: () => Promise<void>;
}

export interface CursorRunResult {
  status: "succeeded" | "failed" | "cancelled";
  summary?: string;
  durationMs: number;
  model?: ModelSelection;
  branches?: Array<{ repoUrl: string; branch?: string; prUrl?: string }>;  // empty for local; populated for cloud (V2)
  errorMessage?: string;
}
```

```typescript
// tower-adapter/src/index.ts
export interface TowerAdapter {
  getRepo(name: string): Promise<TowerRepo | null>;
  addWorktree(input: AddWorktreeInput): Promise<TowerWorktree>;
  getWorktree(input: { repo: string; name: string }): Promise<TowerWorktree | null>;
  removeWorktree(input: { repo: string; name: string }): Promise<void>;
}
```

```typescript
// core/src/index.ts
export interface ShipService {
  ship(input: ShipInput): Promise<ShipOutput>;
  getRun(workflowRunId: string): Promise<WorkflowRun | null>;
  listRuns(filter: ListWorkflowRunsInput): Promise<WorkflowRun[]>;
  cancelRun(workflowRunId: string): Promise<{ workflowRunId: string; status: WorkflowStatus }>;
}
```

## Data model

### `WorkflowStatus`

```typescript
type WorkflowStatus =
  | "pending"        // row created, no phase started
  | "running"        // a phase is in progress
  | "succeeded"      // last phase succeeded
  | "failed"         // last phase failed
  | "cancelled";     // cancelled by user
```

V1 has only the implement phase, so the workflow status mirrors the implement phase's outcome. V2 will add states like `awaiting_review` or `needs_human` once more phases exist.

### `Phase`

```typescript
type PhaseKind = "implement";  // V1 only — V2 adds open_pr, review, ci_fix, ...

type PhaseStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

interface Phase {
  id: string;
  workflowRunId: string;
  kind: PhaseKind;
  status: PhaseStatus;
  startedAt?: string;
  endedAt?: string;
  cursorRunId?: string;
  inputJson: string;            // phase-specific input
  outputJson?: string;          // phase-specific output
  errorMessage?: string;
}
```

### `WorkflowRun`

```typescript
interface WorkflowRun {
  id: string;                   // ULID
  repo: string;
  docPath: string;              // relative to repo root
  status: WorkflowStatus;
  baseRef: string;
  worktree: WorktreeRef;
  policy: WorkflowPolicy;
  createdAt: string;
  updatedAt: string;
  phases: Phase[];              // ordered chronologically; V1 always has 0 or 1
}
```

### `WorktreeRef`, `CursorRunRef`

```typescript
interface WorktreeRef {
  repo: string;
  name: string;
  branch: string;
  path: string;
  baseRef: string;
}

interface CursorRunRef {
  id: string;                   // SDK run ID
  agentId: string;              // SDK agent ID
  runtime: "local";             // V2 adds "cloud"
  model?: ModelSelection;
  startedAt: string;
  endedAt?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  durationMs?: number;
  artifactsDir: string;         // <UserConfigDir>/ship/runs/<workflowRunId>/
}
```

### `WorkflowPolicy`

V1 only honors three policy fields (the rest are reserved for V2 phases and can sit on the row but go unused):

```typescript
interface WorkflowPolicy {
  baseRef: string;              // default main
  maxRunDurationMs: number;     // default 30 minutes; cursor run is cancelled past this
  agentTimeoutMs: number;       // SDK-level timeout; default same as maxRunDurationMs
}
```

### SQL schema

```sql
CREATE TABLE workflow_runs (
  id          TEXT PRIMARY KEY,
  repo        TEXT NOT NULL,
  doc_path    TEXT NOT NULL,
  status      TEXT NOT NULL,
  base_ref    TEXT NOT NULL,
  worktree_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX workflow_runs_repo_idx ON workflow_runs (repo);
CREATE INDEX workflow_runs_status_idx ON workflow_runs (status);

CREATE TABLE phases (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT,
  cursor_run_id   TEXT,
  input_json      TEXT NOT NULL,
  output_json     TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX phases_workflow_run_id_idx ON phases (workflow_run_id);

CREATE TABLE cursor_runs (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  runtime         TEXT NOT NULL,
  model_json      TEXT,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_ms     INTEGER,
  artifacts_dir   TEXT NOT NULL
);
CREATE INDEX cursor_runs_workflow_run_id_idx ON cursor_runs (workflow_run_id);
```

### State transitions

```
pending --(implement starts)--> running
running --(implement succeeds)--> succeeded
running --(implement fails)--> failed
running --(user cancels)--> cancelled
pending --(user cancels)--> cancelled
```

Terminal states: `succeeded`, `failed`, `cancelled`. Once terminal, no further transitions allowed (resuming/retrying creates a new `WorkflowRun`).

## Implementation prompt template

Stored as a Markdown template; rendered with the task doc inserted verbatim.

```markdown
You are implementing a task document in a real repository.

Task doc:
---
{TASK_DOC}
---

Repo: {REPO}
Worktree path: {WORKTREE_PATH}
Branch: {BRANCH}
Base ref: {BASE_REF}

Rules:
1. Stay inside the worktree path. All file edits happen there.
2. Follow the task doc closely. If the doc names tests, write or update them. If the doc lists acceptance criteria, your work is done when they pass.
3. Run the required checks listed in the doc, or detected from the repo (e.g. `pnpm test`, `go test ./...`).
4. Do not expand scope beyond the task doc unless needed to make tests pass.
5. If you are blocked (missing context, conflicting requirements, environment failure), stop and write a short blocker note instead of guessing.
6. Do NOT open a pull request. Ship will handle that as a separate phase.
7. At the end, produce a structured summary as the last assistant message:
   - Files changed (paths)
   - Tests added or updated (paths)
   - Tests run, with pass/fail
   - Summary of changes (3-5 sentences)
   - Risks and follow-ups
   - Any blockers encountered
```

The summary at the end is what `summary.md` is extracted from. Ship looks for the structured fields in the final assistant message and falls back to dumping the full final assistant text if the structure isn't found.

## Validation plan

### Unit tests (Vitest)

- `workflow` / `mcp`: every Zod schema parses valid input and rejects invalid input. ULID format, status enum coverage, slug validation for worktree names. Each package has its own test suite.
- `store`: round-trip every entity. Migration runs cleanly on an empty DB. `cancelRun` is idempotent. `listRuns` filters and orders correctly.
- `core` with fakes: state transitions, artifact path generation, prompt rendering with a sample task doc, error handling when Tower / Cursor / FS fails. The fake `CursorRunner` emits a scripted sequence of events including success and failure paths.
- `mcp-server` with a fake `ShipService`: each tool handler validates input, calls the right method, formats output.
- `tower-adapter` with a recorded MCP transcript: response parsing.
- `cursor-runner`: prompt assembly, options mapping. The actual SDK is mocked.

### Integration tests (gated, opt-in)

Behind `SHIP_LIVE=1`:

- A throwaway test repo with one tiny task doc ("add a `hello` function and a test for it"). Run the actual Ship `ship` flow end-to-end against a real Cursor SDK and a real Tower instance. Assert: worktree created, files changed, tests pass in the worktree, `result.json` populated, `summary.md` non-empty.
- Cancellation: launch a long-running implementation, cancel via the API, assert the run terminates within 5 seconds and the worktree state matches the partial output.

### Spike work (precedes coding)

Before scaffolding `cursor-runner`, run a half-day spike (`spike/local-run.ts` — throwaway, NOT in the package layout) that:

1. Installs `@cursor/sdk` in a sibling temp dir.
2. Launches a single local agent with a trivial prompt ("list the files at the top level") in a known cwd.
3. Streams events to stdout.
4. Awaits `run.wait()` and dumps `RunResult`.

What we need to learn from the spike:

- Are `Agent.create` / `agent.send` / `run.stream()` / `run.wait()` shaped exactly as documented?
- What does `RunResult.git` look like for local? (Documented as empty; verify.)
- What's the lag between events arriving and disk I/O — do we need batching for `events.ndjson`?
- How does cancellation actually behave?
- Are tool-call events stable enough to log even with `args` as opaque?

The spike answers feed back into the `CursorRunner` implementation. The spike code is not committed beyond a short summary note appended to `docs/cursor-sdk-typescript.md`.

### Acceptance criteria for V1

V1 is "done" when:

- `ship ship docs/features/hello.md --repo ship` (with a trivial hello-world task doc on Ship's own repo) produces a Tower worktree with the implementation, runs visible in `ship list`, and `ship status <id>` shows succeeded.
- All unit tests pass on Linux + Windows CI.
- `pnpm check` passes (typecheck + lint + format).
- The four MCP tools work from at least one MCP client (Cursor or Claude Code).
- Cancellation works.
- `docs/features/ship-v1/spec.md` open questions are resolved.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `@cursor/sdk` doesn't behave as documented | Whole project blocked | Half-day spike before scaffolding `cursor-runner`; runner is behind an interface so we can swap implementations. |
| Tower MCP integration is rougher than expected | Adapter rewrite | Tower is local and the MCP surface is documented; if needed, fall back to spawning `tower` CLI in V2. |
| Local Cursor runtime can't see env vars / `.cursorrules` correctly inside a Tower worktree | Agent runs blind | Document `settingSources` precedence in `cursor-runner` README. The spike checks this. |
| Long-running runs without disconnection support | A Ship restart loses an in-flight run | V1 accepts this. Cloud runtime (V2) is what fixes durable runs. We document the limitation; the user re-`ship`s. |
| Tool-call payloads churn between SDK versions | NDJSON archive becomes unparseable | We treat `args`/`result` as opaque; views are built from the agent's structured summary, not from tool call introspection. Documented in `docs/cursor-sdk-typescript.md`. |
| Strict lint blocks the team | Slowdown if rules are wrong-shaped | Bake the config from day one and refactor when it bites. Tower's pattern: split big functions rather than adding suppressions. |
| `docPath` traversal | Security issue | Resolve `docPath` against the repo root, reject if normalized path escapes. Also reject symlinks crossing the boundary. |
| Cursor API key handling | Credential leak | Read from env only; never log; never write into NDJSON. The `cursor-runner` package never accepts a key in any persisted struct. |

## Open questions

These need answers before implementation begins. Default proposals are listed; the user can override.

1. ~~**Default model.**~~ **Resolved (2026-05-06):** `composer-2`. Verified against `Cursor.models.list()` in spike #1 — alive, deterministic, behaves well on the trivial probe. `default` (Auto) is also available for "I don't care" users; expose as a config option but don't make it the V1 default.
2. **Worktree base location.** Tower defaults to `<repo>/.worktrees/<name>`. Confirm we adopt the same.
3. **Implementation timeout.** Proposed: 30 minutes default, configurable per-call. Aligns with what one feature-sized task doc tends to take.
4. **MCP elicitation.** Cursor MCP supports elicitation. Should `ship` ask the user for confirmation before launching a run, or fire-and-forget? Proposed: fire-and-forget; the user already chose to call `ship`.
5. ~~**Failure of the structured summary parser.**~~ **Resolved (2026-05-06):** dropped from the critical path. Spike #1 confirmed `RunResult.result` is the final assistant text directly — Ship reads it as `summary.md` with no parsing required. The implementation prompt template can still request structured fields for human readability inside the summary, but Ship doesn't extract them.
6. **Resume support.** SDK has `Agent.resume`. Do we let the user attach a new `send()` to a previous workflow run? Proposed: not in V1. Each `ship` is a fresh agent. Resume is V2.
7. **Concurrent runs on the same worktree.** What if two `ship` invocations target the same worktree name? Proposed: reject the second with a clear error. Concurrent runs require unique worktree names.
8. **Where does the snapshot of the task doc live?** `runs/<id>/task-doc.md` — we copy the doc content at run start so historical runs are self-contained even if the doc later changes.
9. **Cleanup CLI.** Should there be a `ship cleanup <run_id>` that removes the worktree and the `runs/<id>/` directory? Proposed: yes, but explicit only — no auto-cleanup. The user can also manually `rm` and let `ship list` show stale entries.
10. **MCP server lifetime.** Long-running daemon vs spawned-per-call by the MCP client? Proposed: stdio per call (Cursor and Claude Code spawn the server), but `ShipService` is reentrant so a daemon mode is a future option.

## Implementation plan

Once this doc is approved, work proceeds in order:

1. **Spike.** `spike/local-run.ts` — verify SDK behavior. Output a short addendum to `docs/cursor-sdk-typescript.md`.
2. **Scaffold.** Monorepo + tooling: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`, `.gitignore`, `Taskfile.yml`, CI workflow. No package code yet.
3. **`packages/workflow` + `packages/mcp`.** Zod schemas + types, split per the import-pattern analysis. Tests. See [phases/02-type-system.md](phases/02-type-system.md).
4. **`packages/store`.** Drizzle schema, migrations, `Store` interface. Tests.
5. **`packages/tower-adapter`.** MCP client. Tests against recorded transcript.
6. **`packages/cursor-runner`.** `CursorRunner` interface + `@cursor/sdk` impl. `FakeCursorRunner` exported for downstream tests.
7. **`packages/core`.** `ShipService`. Tests using fakes from #5 and #6.
8. **`packages/cli`.** Commander binary. Smoke tests via the fake-runner-backed service.
9. **`packages/mcp-server`.** MCP tools. Smoke tests via the fake-runner-backed service.
10. **Integration test.** Trivial task doc, real SDK, real Tower. Gated behind `SHIP_LIVE=1`.
11. **README + dogfood.** First real task doc shipped through Ship is a Ship feature.

Each step lands as its own PR (or `ship` workflow run, once we can dogfood) with passing CI.

# Cursor-Powered Dev Workflow MCP Toolkit

**Working title:** `shipyard`, `forge`, `repo-pilot`, or `cursor-tower`  
**Owner:** itsHabib  
**Document purpose:** Feed this into an implementation/design agent to start building the project.  
**Date:** 2026-05-04  
**Primary goal:** Build an opinionated MCP toolkit and optional app for the way Habib ships code with agents: design docs, TDD/task docs, isolated worktrees, Cursor-powered implementation, PRs, agent review cycles, CI/comment repair, and merge readiness.

---

## 0. Executive Summary

This project is a **Cursor SDK-powered MCP toolkit for repo-focused agentic development workflows**.

It should not be framed as a generic multi-agent orchestration framework. The more valuable framing is:

> A repo-native workflow coordinator that turns approved task docs into tracked Cursor-agent worktrees, branches, pull requests, review cycles, CI repair loops, and merge-ready changes.

The product sits between three systems:

1. **Cursor SDK** — executes coding-agent work against repositories, locally or in Cursor cloud.
2. **Tower** — owns local repo/worktree/branch/PR/CI/review state through CLI/TUI/MCP.
3. **This new toolkit** — owns the end-to-end development workflow state machine: design doc → worktree → implementation → PR → review cycles → CI/comment repair → human escalation → merge.

The initial user is Habib. The product should encode his current workflow rather than trying to be flexible for everyone on day one.

Habib’s current workflow:

```text
1. Create design / TDD / task docs.
2. Review docs with agents and self-review when needed.
3. Split up work.
4. For each task:
   - create worktree off main
   - create branch
   - implement task doc
   - get PR up
   - ask review from all agents
   - ensure CI is addressed
   - ensure comments are addressed
   - do at most 3 review cycles before pinging a person
   - merge
```

The toolkit should turn that loop into first-class commands and MCP tools.

---

## 1. Product Thesis

### 1.1 What this is

A TypeScript-native MCP server and optional dashboard/CLI that coordinates Cursor SDK agents around real repo work.

Core promise:

> Give me a task doc, and I will create the worktree, launch a Cursor agent, open a PR, run agent reviews, babysit CI/comments for up to three cycles, and tell you when it is ready to merge or needs a human.

### 1.2 What this is not

This is **not**:

- another abstract agent DAG framework
- a replacement for Tower
- a replacement for Cursor
- a generic chat app
- a general-purpose project manager
- a fully autonomous merge bot on day one

It is a **dev workflow tool**.

### 1.3 Why this can be valuable

Cursor SDK provides the agent runtime. Tower provides worktree visibility. But neither owns the full workflow discipline:

- design-doc-first development
- task-doc implementation boundaries
- agent review policies
- max review cycles
- CI repair loops
- comment triage
- human escalation
- merge readiness criteria
- durable workflow state across many parallel branches

This toolkit owns those missing pieces.

---

## 2. Grounding in Known External Systems

This section captures current external assumptions. Verify these against live docs during implementation because Cursor SDK is new and may change.

### 2.1 Cursor SDK facts to rely on

Based on Cursor’s public SDK announcement and changelog:

- Cursor SDK is a TypeScript SDK available as `@cursor/sdk`.
- It exposes Cursor agents programmatically through APIs such as `Agent.create`, `agent.send(...)`, `run.stream()`, and cloud run retrieval APIs such as `Agent.getRun(...)` in examples.
- It can run agents locally or on Cursor cloud.
- Cloud SDK sessions run on Cursor’s Cloud Agents runtime, with dedicated VMs, repo clones, sandboxing, and configured dev environments.
- Cloud agents can continue running after local disconnects, stream/reconnect, and produce branches, PRs, and artifacts such as demos/screenshots.
- SDK-launched agents use Cursor’s harness: codebase indexing, semantic search, grep, MCP servers, repo skills from `.cursor/skills/`, hooks from `.cursor/hooks.json`, and subagents.
- Cursor explicitly positions SDK use cases around CI/CD, automation, PR updates, CI failure diagnosis, and custom agent platforms.

Reference URLs:

- https://cursor.com/blog/typescript-sdk
- https://cursor.com/changelog/sdk-release
- https://github.com/cursor/cookbook

### 2.2 Cursor MCP facts to rely on

Cursor supports MCP servers as external tool/data providers. Cursor MCP supports at least:

- stdio transport
- SSE transport
- Streamable HTTP transport
- tools
- prompts
- roots
- elicitation

Cursor MCP config can be project-local via `.cursor/mcp.json` or global via `~/.cursor/mcp.json`.

Reference URL:

- https://docs.cursor.com/context/model-context-protocol

### 2.3 MCP TypeScript SDK fact to note

The official MCP TypeScript SDK repository currently indicates that the main branch contains v2 in development/pre-alpha and that v1.x remains the recommended production version until v2 stabilizes. Use this as an implementation consideration.

Reference URL:

- https://github.com/modelcontextprotocol/typescript-sdk

### 2.4 Tower facts to rely on

Tower already exists at `github.com/itsHabib/tower` and should be treated as the worktree substrate.

Known Tower capabilities from its README:

- It is a TUI, CLI, and MCP server.
- It tracks parallel agentic work across repos and worktrees.
- Each worktree maps to a branch and eventually a PR.
- It tracks local git state, GitHub PR/review/CI state, and worktree paths.
- It exposes MCP tools including:
  - `list_worktrees`
  - `get_worktree`
  - `add_worktree`
  - `remove_worktree`
  - `sync`
  - `reconcile`
  - `list_repos`
  - `register_repo`
  - `unregister_repo`
  - `prune_repos`

Reference URL:

- https://github.com/itsHabib/tower

---

## 3. Product Name Options

Pick one later. Names should imply shipping/dev workflow, not vague orchestration.

Good candidates:

- `shipyard` — a place where branches/PRs get built and launched.
- `forge` — turns task docs into code changes.
- `repo-pilot` — repo-native agent operator.
- `crew` — agents as workers, but slightly generic.
- `dock` — worktrees/PRs docked in one workflow.
- `cursor-tower` — explicit but tied to Cursor/Tower.
- `dockhand` — helps ship work through PR lifecycle.

For now, this document will use **Shipyard** as the working name.

---

## 4. Core User Stories

### 4.1 Design doc creation

As Habib, I want to ask an agent to create a design/TDD/task doc for a feature so that implementation starts with a clear plan.

Example:

```text
Create a design doc for adding Cursor SDK support to the dev workflow MCP toolkit.
Include goals, non-goals, data model, tests, and implementation phases.
```

Expected output:

- markdown design doc under `docs/features/<slug>.md` or configured doc directory
- status recorded as `design_doc_draft`
- optional review tasks created

### 4.2 Design doc review

As Habib, I want agents to review the doc before implementation so that ambiguity is resolved early.

Expected behavior:

- run one or more review agents
- store review artifacts
- optionally revise the doc
- mark doc approved manually or automatically if configured

### 4.3 Ship task doc

As Habib, I want one command/tool that takes an approved task doc and drives it through implementation and PR setup.

Example:

```text
ship_task_doc(repo="orchestra", docPath="docs/features/artifact-substrate.md")
```

Expected behavior:

1. Validate task doc exists.
2. Ask Tower to create or locate a worktree.
3. Create a branch off main.
4. Launch Cursor agent to implement the doc.
5. Stream agent events to persisted run logs.
6. Open/update PR.
7. Record branch, worktree path, PR URL, artifacts.
8. Move workflow state to `pr_opened` or `failed`.

### 4.4 Run review cycle

As Habib, I want to ask review agents to review the PR, then have the implementation agent address comments.

Expected behavior:

- request configured agent reviews
- collect comments/findings
- launch a Cursor fix run if changes are needed
- push updates
- repeat up to `maxReviewCycles`, default 3
- stop and request human help after limit

### 4.5 Fix CI

As Habib, I want the tool to detect failing CI and launch a Cursor agent to fix it.

Expected behavior:

- fetch/check CI status through Tower or GitHub adapter
- collect failing check names/logs when possible
- launch Cursor agent with relevant logs and task doc context
- push fix
- rerun status sync
- record attempt count
- stop after configured max attempts

### 4.6 Next action

As Habib, I want the tool to tell me what to do next across all active work.

Expected behavior:

- sync Tower state
- read workflow state
- rank work items by urgency/actionability
- produce recommendations such as:
  - “PR green and approved: merge_when_green”
  - “CI failing: run fix_ci”
  - “review cycle limit hit: escalate_to_human”
  - “implementation still running: check later”
  - “doc draft lacks review: review_task_doc”

---

## 5. Architecture Overview

### 5.1 High-level architecture

```text
Cursor / Claude / ChatGPT / CLI
        |
        | MCP tools/prompts/resources
        v
+----------------------------+
| Shipyard MCP Server        |
| - workflow tools           |
| - prompts                  |
| - resources                |
+-------------+--------------+
              |
              v
+----------------------------+
| Shipyard Core              |
| - workflow state machine   |
| - recipes                  |
| - policies                 |
| - artifacts                |
| - run/event persistence    |
+------+------+--------------+
       |      |
       |      +----------------------+
       |                             |
       v                             v
+-------------+              +----------------+
| Tower MCP   |              | Cursor SDK     |
| Adapter     |              | Runner         |
| worktrees   |              | agents/runs    |
| PR/CI view  |              | cloud/local    |
+-------------+              +----------------+
       |
       v
+-------------+
| Git/GitHub  |
+-------------+
```

### 5.2 Responsibility split

#### Tower owns

- repo registration
- worktree creation/removal
- branch/worktree mapping
- local git status
- PR/CI/review state snapshots
- TUI/CLI for worktree overview

#### Shipyard owns

- workflow state machine
- design/task doc lifecycle
- Cursor SDK run lifecycle
- review cycle policy
- CI repair policy
- human escalation policy
- persisted agent run artifacts
- MCP tools at workflow level
- optional dashboard and CLI

#### Cursor SDK owns

- actual coding-agent execution
- local/cloud runtime
- agent stream events
- codebase context harness
- tool use through Cursor harness
- branches/PRs/artifacts produced by cloud agents where supported

---

## 6. Initial Package Layout

Use TypeScript from day one because Cursor SDK is TypeScript-first.

Recommended monorepo:

```text
shipyard/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md
  docs/
    DESIGN.md
    ROADMAP.md
    examples/
  apps/
    dashboard/              # optional Next.js app; not MVP-critical
  packages/
    core/                   # workflow engine, state machine, policies
    mcp-server/             # MCP tool/prompt/resource surface
    cursor-runner/          # @cursor/sdk wrapper
    tower-adapter/          # Tower MCP/CLI client wrapper
    github-adapter/         # direct GitHub fallback/augmentations
    store/                  # SQLite/Drizzle or Prisma persistence
    cli/                    # optional local CLI wrapper
    recipes/                # built-in workflow recipes
    shared/                 # shared types/schemas
```

### 6.1 MVP package subset

For the first version, only build:

```text
packages/shared
packages/store
packages/tower-adapter
packages/cursor-runner
packages/core
packages/mcp-server
packages/cli          # optional but useful for local debugging
```

Defer dashboard until state/events are real.

---

## 7. Core Domain Model

### 7.1 WorkflowRun

A workflow run is the top-level object representing “ship this thing.”

```ts
export type WorkflowStatus =
  | "idea"
  | "design_doc_draft"
  | "design_doc_review"
  | "approved"
  | "worktree_created"
  | "implementing"
  | "pr_opened"
  | "agent_review"
  | "addressing_feedback"
  | "fixing_ci"
  | "needs_human"
  | "ready_to_merge"
  | "merged"
  | "failed"
  | "canceled";

export interface WorkflowRun {
  id: string;
  title: string;
  repo: string;              // logical Tower repo name or full repo slug
  repoUrl?: string;
  baseRef: string;           // usually main
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;

  designDoc?: DocRef;
  taskDoc?: DocRef;
  worktree?: WorktreeRef;
  pr?: PullRequestRef;

  cursorRuns: CursorRunRef[];
  artifacts: ArtifactRef[];
  reviewCycles: ReviewCycle[];
  ciAttempts: CIAttempt[];
  humanEscalations: HumanEscalation[];

  policy: WorkflowPolicy;
  metadata?: Record<string, unknown>;
}
```

### 7.2 DocRef

```ts
export interface DocRef {
  path: string;
  kind: "design" | "tdd" | "task" | "review";
  status: "draft" | "reviewed" | "approved" | "rejected";
  commitSha?: string;
  lastReviewedAt?: string;
}
```

### 7.3 WorktreeRef

```ts
export interface WorktreeRef {
  repo: string;
  name: string;
  branch: string;
  path: string;
  baseRef: string;
  createdBy: "tower" | "manual";
}
```

### 7.4 PullRequestRef

```ts
export interface PullRequestRef {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "draft" | "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  lastSyncedAt?: string;
}
```

### 7.5 CursorRunRef

```ts
export interface CursorRunRef {
  id: string;
  agentId?: string;
  runtime: "local" | "cloud" | "self_hosted";
  purpose:
    | "design"
    | "implementation"
    | "review"
    | "ci_fix"
    | "comment_fix"
    | "merge_prep"
    | "other";
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  model?: string;
  startedAt: string;
  endedAt?: string;
  streamLogPath?: string;
  result?: CursorRunResult;
}

export interface CursorRunResult {
  summary?: string;
  branch?: string;
  prUrl?: string;
  filesChanged?: string[];
  artifacts?: ArtifactRef[];
  error?: string;
}
```

### 7.6 ArtifactRef

```ts
export interface ArtifactRef {
  id: string;
  workflowRunId: string;
  cursorRunId?: string;
  key: string;
  type: "text" | "json" | "markdown" | "log" | "diff" | "image" | "url";
  path?: string;
  url?: string;
  sizeBytes?: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

### 7.7 ReviewCycle

```ts
export interface ReviewCycle {
  index: number; // 1-based
  startedAt: string;
  endedAt?: string;
  reviewers: AgentReviewerRun[];
  findings: ReviewFinding[];
  fixRunId?: string;
  outcome: "pending" | "changes_requested" | "approved" | "needs_human" | "failed";
}

export interface AgentReviewerRun {
  reviewer: string;
  cursorRunId: string;
  status: "running" | "completed" | "failed";
}

export interface ReviewFinding {
  id: string;
  reviewer: string;
  severity: "info" | "warning" | "blocking";
  file?: string;
  line?: number;
  message: string;
  suggestedFix?: string;
  status: "open" | "addressed" | "wont_fix";
}
```

### 7.8 WorkflowPolicy

```ts
export interface WorkflowPolicy {
  maxReviewCycles: number;      // default 3
  maxCiFixAttempts: number;     // default 3
  requireDesignApproval: boolean;
  requireGreenCi: boolean;
  requireAgentApproval: boolean;
  requireHumanBeforeMerge: boolean;
  autoOpenPr: boolean;
  autoMerge: boolean;           // default false
  allowedReviewers: string[];
}
```

---

## 8. Workflow State Machine

### 8.1 State transitions

```text
idea
  -> design_doc_draft
  -> design_doc_review
  -> approved
  -> worktree_created
  -> implementing
  -> pr_opened
  -> agent_review
  -> addressing_feedback
  -> agent_review
  -> fixing_ci
  -> ready_to_merge
  -> merged
```

Failure/escape transitions:

```text
any active state -> failed
any active state -> canceled
agent_review with reviewCycles >= 3 -> needs_human
fixing_ci with ciAttempts >= 3 -> needs_human
```

### 8.2 Transition rules

- `approved` requires design/task doc status = approved if `requireDesignApproval` is true.
- `worktree_created` requires Tower worktree ref.
- `implementing` requires Cursor run started.
- `pr_opened` requires PR URL/number.
- `agent_review` requires PR ref.
- `ready_to_merge` requires:
  - green CI if required
  - no blocking review findings
  - review cycle completed
  - PR open
- `merged` requires merge confirmation from GitHub/Tower.
- `needs_human` is terminal until manually resumed.

### 8.3 Next action planner

Implement a deterministic planner:

```ts
export function recommendNextActions(run: WorkflowRun, towerSnapshot?: TowerSnapshot): NextAction[];
```

Rules:

```text
- If status = design_doc_draft: recommend review_task_doc.
- If status = approved and no worktree: recommend create_task_worktree.
- If worktree exists and no implementation cursor run: recommend implement_task_doc.
- If PR exists and CI failing: recommend fix_ci.
- If PR exists and review comments open: recommend address_review_comments.
- If review cycles < max and no approval: recommend run_review_cycle.
- If review cycles >= max and unresolved findings: recommend escalate_to_human.
- If green + approved: recommend merge_when_green.
```

This deterministic layer is important. Do not rely on an LLM to decide workflow state transitions in the MVP.

---

## 9. MCP Tool Surface

The MCP server should expose workflow-level tools. Avoid low-level wrappers that duplicate Tower/GitHub unless needed.

### 9.1 Tool naming principles

Good tool names:

- `create_task_doc`
- `review_task_doc`
- `ship_task_doc`
- `get_workflow_run`
- `list_workflow_runs`
- `next_action`
- `run_review_cycle`
- `fix_ci`
- `address_review_comments`
- `escalate_to_human`
- `merge_when_green`

Avoid tool names like:

- `create_branch`
- `run_agent`
- `post_comment`

Those are implementation details.

### 9.2 `create_task_doc`

Creates a design/TDD/task doc in the repo.

Input:

```ts
interface CreateTaskDocInput {
  repo: string;
  title: string;
  context: string;
  docKind?: "design" | "tdd" | "task";
  targetDir?: string; // default docs/features
  useCursorAgent?: boolean;
}
```

Output:

```ts
interface CreateTaskDocOutput {
  workflowRunId: string;
  docPath: string;
  status: "design_doc_draft";
  summary: string;
}
```

MVP behavior:

- If `useCursorAgent=false`, create a doc from a deterministic template.
- If `useCursorAgent=true`, launch Cursor local agent in repo root to draft the doc.
- Store workflow run.

### 9.3 `review_task_doc`

Reviews a task/design doc with one or more agents.

Input:

```ts
interface ReviewTaskDocInput {
  workflowRunId?: string;
  repo?: string;
  docPath: string;
  reviewers?: string[]; // default from config
  applyRevisions?: boolean;
}
```

Output:

```ts
interface ReviewTaskDocOutput {
  workflowRunId: string;
  reviewArtifacts: ArtifactRef[];
  findings: ReviewFinding[];
  status: "design_doc_review" | "approved";
}
```

MVP behavior:

- Run review prompts using Cursor SDK or a simpler LLM path if needed.
- Store review artifacts.
- Do not auto-approve unless explicitly configured.

### 9.4 `approve_task_doc`

Marks doc as approved.

Input:

```ts
interface ApproveTaskDocInput {
  workflowRunId: string;
  notes?: string;
}
```

Output:

```ts
interface ApproveTaskDocOutput {
  workflowRunId: string;
  status: "approved";
}
```

### 9.5 `ship_task_doc`

Primary workflow tool. Takes an approved task doc and drives implementation to PR/review readiness.

Input:

```ts
interface ShipTaskDocInput {
  workflowRunId?: string;
  repo: string;
  docPath: string;
  worktreeName?: string;
  baseRef?: string;                // default main
  runtime?: "local" | "cloud";     // default cloud when repo URL available
  model?: string;                  // default from config
  autoCreatePR?: boolean;          // default true
  reviewAgents?: string[];         // default from config
  maxReviewCycles?: number;        // default 3
  runInitialReview?: boolean;      // default true after PR opens
}
```

Output:

```ts
interface ShipTaskDocOutput {
  workflowRunId: string;
  worktree?: WorktreeRef;
  cursorRun: CursorRunRef;
  pr?: PullRequestRef;
  status: WorkflowStatus;
  nextActions: NextAction[];
}
```

MVP behavior:

1. Resolve or create workflow run.
2. Validate/approve doc policy.
3. Call Tower adapter to create worktree if using local runtime.
4. Launch Cursor SDK implementation agent.
5. Persist stream events.
6. Capture branch/PR result.
7. Sync Tower.
8. Optionally start review cycle.

### 9.6 `get_workflow_run`

Returns durable state.

Input:

```ts
interface GetWorkflowRunInput {
  workflowRunId: string;
  includeEvents?: boolean;
  includeArtifacts?: boolean;
}
```

Output: `WorkflowRun` plus optional event/artifact details.

### 9.7 `list_workflow_runs`

Input:

```ts
interface ListWorkflowRunsInput {
  repo?: string;
  status?: WorkflowStatus[];
  activeOnly?: boolean;
  limit?: number;
}
```

Output:

```ts
interface ListWorkflowRunsOutput {
  runs: WorkflowRun[];
}
```

### 9.8 `next_action`

Recommends what to do next.

Input:

```ts
interface NextActionInput {
  repo?: string;
  workflowRunId?: string;
  syncTower?: boolean;
}
```

Output:

```ts
interface NextActionOutput {
  recommendations: NextAction[];
}

interface NextAction {
  workflowRunId?: string;
  repo?: string;
  branch?: string;
  prUrl?: string;
  priority: "low" | "normal" | "high" | "urgent";
  action:
    | "review_task_doc"
    | "ship_task_doc"
    | "check_cursor_run"
    | "fix_ci"
    | "address_review_comments"
    | "run_review_cycle"
    | "escalate_to_human"
    | "merge_when_green"
    | "do_nothing";
  reason: string;
  suggestedToolCall?: Record<string, unknown>;
}
```

### 9.9 `run_review_cycle`

Runs agent reviews and optionally asks implementation agent to fix issues.

Input:

```ts
interface RunReviewCycleInput {
  workflowRunId: string;
  reviewers?: string[];
  maxCycles?: number;
  autoFix?: boolean;
}
```

Output:

```ts
interface RunReviewCycleOutput {
  workflowRunId: string;
  cycle: ReviewCycle;
  status: WorkflowStatus;
  nextActions: NextAction[];
}
```

Behavior:

- If current review cycle count >= max, do not run more agents; return `needs_human` recommendation.
- Launch configured review agents.
- Store review artifacts/findings.
- If blocking findings and autoFix, launch Cursor fix agent.
- Sync PR/Tower.

### 9.10 `fix_ci`

Input:

```ts
interface FixCiInput {
  workflowRunId: string;
  maxAttempts?: number;
  includeLogs?: boolean;
}
```

Output:

```ts
interface FixCiOutput {
  workflowRunId: string;
  attempt: CIAttempt;
  status: WorkflowStatus;
  nextActions: NextAction[];
}
```

Behavior:

- Determine failing checks from Tower/GitHub.
- Fetch logs where possible.
- Launch Cursor run with check names/logs/task doc/PR context.
- Store artifact with diagnosis and fix summary.

### 9.11 `address_review_comments`

Input:

```ts
interface AddressReviewCommentsInput {
  workflowRunId: string;
  commentIds?: string[];
  maxAttempts?: number;
}
```

Output:

```ts
interface AddressReviewCommentsOutput {
  workflowRunId: string;
  cursorRun: CursorRunRef;
  status: WorkflowStatus;
}
```

### 9.12 `escalate_to_human`

Input:

```ts
interface EscalateToHumanInput {
  workflowRunId: string;
  reason: string;
  assignee?: string;
  channel?: "github" | "stdout" | "slack" | "manual";
}
```

Output:

```ts
interface EscalateToHumanOutput {
  workflowRunId: string;
  status: "needs_human";
  message: string;
  prUrl?: string;
}
```

MVP can just create a GitHub PR comment or return a message.

### 9.13 `merge_when_green`

Input:

```ts
interface MergeWhenGreenInput {
  workflowRunId: string;
  strategy?: "squash" | "merge" | "rebase";
  requireHumanApproval?: boolean;
}
```

Output:

```ts
interface MergeWhenGreenOutput {
  workflowRunId: string;
  status: "merged" | "ready_to_merge" | "needs_human";
  message: string;
}
```

MVP should default to **not auto-merging**. It can return “ready to merge” and provide the command/link.

---

## 10. MCP Resources and Prompts

### 10.1 Resources

Expose readable resources for agents:

```text
shipyard://runs
shipyard://runs/{run_id}
shipyard://runs/{run_id}/events
shipyard://runs/{run_id}/artifacts
shipyard://runs/{run_id}/review-cycles
shipyard://repos
shipyard://next-actions
```

### 10.2 Prompts

Expose MCP prompts for reusable workflows:

```text
shipyard:create-design-doc
shipyard:review-design-doc
shipyard:ship-task-doc
shipyard:fix-ci
shipyard:review-pr
shipyard:merge-readiness
```

Prompt example: `shipyard:ship-task-doc`

```text
You are operating Habib's repo-shipping workflow.

Given a repo and task doc:
1. Verify the task doc is specific enough to implement.
2. Use ship_task_doc to create/locate a worktree and launch a Cursor implementation agent.
3. Track the workflow run.
4. When the PR exists, run review cycle if requested.
5. Use next_action to decide what remains.
6. Stop after at most 3 review/fix cycles and escalate to a human if unresolved.

Do not merge automatically unless explicitly instructed.
```

---

## 11. Cursor Runner Design

### 11.1 Interface

```ts
export interface CursorRunner {
  startRun(input: StartCursorRunInput): Promise<CursorRunHandle>;
  getRun(input: GetCursorRunInput): Promise<CursorRunSnapshot>;
  streamRun(input: StreamCursorRunInput): AsyncIterable<CursorRunEvent>;
  waitRun(input: WaitCursorRunInput): Promise<CursorRunResult>;
  cancelRun(input: CancelCursorRunInput): Promise<void>;
  followUp(input: FollowUpCursorRunInput): Promise<CursorRunHandle>;
}
```

### 11.2 StartCursorRunInput

```ts
export interface StartCursorRunInput {
  purpose: CursorRunRef["purpose"];
  prompt: string;
  model?: string;
  runtime: "local" | "cloud";

  local?: {
    cwd: string;
  };

  cloud?: {
    repoUrl: string;
    startingRef: string;
    autoCreatePR?: boolean;
  };

  mcpServers?: CursorMcpServerConfig[];
  metadata?: Record<string, unknown>;
}
```

### 11.3 Event persistence

For each Cursor run:

```text
.shipyard/runs/<workflowRunId>/cursor/<cursorRunId>/events.ndjson
.shipyard/runs/<workflowRunId>/cursor/<cursorRunId>/prompt.md
.shipyard/runs/<workflowRunId>/cursor/<cursorRunId>/result.json
```

Store raw events as NDJSON to make debugging possible.

### 11.4 Implementation prompt template

```text
You are implementing a task document in a real repository.

Task doc:
{TASK_DOC_CONTENT}

Repo context:
- repo: {REPO}
- base ref: {BASE_REF}
- branch/worktree: {BRANCH_OR_WORKTREE}
- PR policy: open or update a PR when done

Rules:
1. Follow the task doc closely.
2. Prefer test-first or test-adjacent development when the doc includes TDD notes.
3. Make coherent commits if the runtime supports it; otherwise leave a clean diff.
4. Run the required checks listed in the doc or detected from the repo.
5. Do not expand scope beyond the task doc unless needed to make tests pass.
6. If blocked, write a clear blocker artifact instead of guessing.
7. At the end, produce a structured summary with:
   - files changed
   - tests run
   - risks
   - follow-up work
   - PR URL/branch if available
```

### 11.5 Review prompt template

```text
You are reviewing a pull request produced by an agent.

Inputs:
- Task doc
- PR diff or branch context
- Implementation summary
- CI status if available

Review role: {REVIEWER_ROLE}

Return findings as JSON:
{
  "approval": "approved" | "changes_requested" | "needs_human",
  "findings": [
    {
      "severity": "info" | "warning" | "blocking",
      "file": "optional path",
      "line": "optional line",
      "message": "clear finding",
      "suggestedFix": "optional suggested fix"
    }
  ],
  "summary": "short review summary"
}

Be strict but practical. Do not request changes for style-only preferences unless they create real maintainability risk.
```

### 11.6 CI fix prompt template

```text
You are fixing a failing CI run for a pull request.

Inputs:
- Task doc
- PR branch / worktree
- Failing check names
- CI logs if available
- Recent diff summary

Goal:
Find the smallest correct fix, update the branch, and rerun/describe relevant checks.

Rules:
1. Reproduce the failure locally when possible.
2. Fix the root cause, not just the symptom.
3. Add or update regression tests when appropriate.
4. Do not make unrelated refactors.
5. Produce a structured summary with diagnosis, fix, tests run, and remaining risk.
```

---

## 12. Tower Adapter Design

The Tower adapter should avoid reimplementing Tower. It should call Tower through MCP if possible, or through CLI as fallback.

### 12.1 Interface

```ts
export interface TowerAdapter {
  listRepos(): Promise<TowerRepo[]>;
  listWorktrees(input?: { repo?: string }): Promise<TowerWorktree[]>;
  getWorktree(input: { repo?: string; name?: string; branch?: string }): Promise<TowerWorktree | null>;
  addWorktree(input: { repo: string; name: string; baseRef?: string }): Promise<TowerWorktree>;
  removeWorktree(input: { repo: string; name: string }): Promise<void>;
  sync(input?: { repo?: string }): Promise<TowerSyncResult>;
}
```

### 12.2 TowerWorktree shape

```ts
export interface TowerWorktree {
  repo: string;
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
  ahead?: number;
  behind?: number;
  pr?: {
    number: number;
    url: string;
    state: string;
    title?: string;
  };
  ci?: {
    status: "passing" | "failing" | "pending" | "unknown";
    checks?: TowerCheck[];
  };
  reviews?: TowerReview[];
}
```

### 12.3 Worktree flow

For local Cursor runs:

```text
ship_task_doc
  -> TowerAdapter.addWorktree(repo, worktreeName, baseRef)
  -> CursorRunner.startRun({ runtime: "local", local.cwd = worktree.path })
  -> Cursor agent edits local worktree
  -> Shipyard asks agent/GitHub to push/open PR
  -> TowerAdapter.sync(repo)
```

For cloud Cursor runs:

```text
ship_task_doc
  -> CursorRunner.startRun({ runtime: "cloud", cloud.repoUrl, startingRef })
  -> Cursor cloud agent works in remote clone
  -> Cursor creates branch/PR if autoCreatePR
  -> TowerAdapter.sync(repo)
  -> Tower sees PR/branch later if local worktree exists or branch is checked out
```

Decision:

- MVP should support **local runtime through Tower worktrees** first because it maps exactly to Habib’s current loop.
- Add cloud runtime once Cursor SDK API details are settled and repo auth is verified.

---

## 13. Storage Design

Use SQLite for local-first development.

Recommended:

- SQLite database under `~/.config/shipyard/state.db`
- artifacts under `~/.config/shipyard/artifacts/`
- optional per-repo `.shipyard/` for local run metadata if desired

Use Drizzle or Kysely for TypeScript-friendly schema. Keep migrations simple.

### 13.1 Tables

```sql
workflow_runs (
  id text primary key,
  title text not null,
  repo text not null,
  repo_url text,
  base_ref text not null,
  status text not null,
  policy_json text not null,
  metadata_json text,
  created_at text not null,
  updated_at text not null
)

docs (
  id text primary key,
  workflow_run_id text not null,
  path text not null,
  kind text not null,
  status text not null,
  commit_sha text,
  last_reviewed_at text
)

worktrees (
  id text primary key,
  workflow_run_id text not null,
  repo text not null,
  name text not null,
  branch text not null,
  path text not null,
  base_ref text not null,
  created_by text not null
)

pull_requests (
  id text primary key,
  workflow_run_id text not null,
  repo text not null,
  number integer not null,
  url text not null,
  title text,
  state text not null,
  head_branch text not null,
  base_branch text not null,
  last_synced_at text
)

cursor_runs (
  id text primary key,
  workflow_run_id text not null,
  cursor_run_id text not null,
  agent_id text,
  runtime text not null,
  purpose text not null,
  status text not null,
  model text,
  stream_log_path text,
  result_json text,
  started_at text not null,
  ended_at text
)

artifacts (
  id text primary key,
  workflow_run_id text not null,
  cursor_run_id text,
  key text not null,
  type text not null,
  path text,
  url text,
  size_bytes integer,
  metadata_json text,
  created_at text not null
)

review_cycles (
  id text primary key,
  workflow_run_id text not null,
  cycle_index integer not null,
  outcome text not null,
  started_at text not null,
  ended_at text
)

review_findings (
  id text primary key,
  review_cycle_id text not null,
  reviewer text not null,
  severity text not null,
  file text,
  line integer,
  message text not null,
  suggested_fix text,
  status text not null
)

ci_attempts (
  id text primary key,
  workflow_run_id text not null,
  attempt_index integer not null,
  status text not null,
  cursor_run_id text,
  failing_checks_json text,
  summary text,
  started_at text not null,
  ended_at text
)
```

---

## 14. Configuration

### 14.1 Global config

`~/.config/shipyard/config.yaml`

```yaml
models:
  default: composer-2
  reviewer: gpt-5.5
  ci_fix: composer-2

runtime:
  default: local

policy:
  max_review_cycles: 3
  max_ci_fix_attempts: 3
  require_design_approval: true
  require_green_ci: true
  require_agent_approval: true
  require_human_before_merge: true
  auto_open_pr: true
  auto_merge: false

reviewers:
  correctness:
    model: gpt-5.5
    prompt: "Focus on correctness, edge cases, and whether the implementation satisfies the task doc."
  tests:
    model: composer-2
    prompt: "Focus on tests, regressions, and CI reliability."
  architecture:
    model: gpt-5.5
    prompt: "Focus on maintainability, boundaries, overengineering, and design fit."
  security:
    model: gpt-5.5
    prompt: "Focus on security, auth, data exposure, unsafe shell commands, and dependency risks."

docs:
  default_dir: docs/features

integrations:
  tower:
    mode: mcp # mcp | cli
  github:
    mode: gh # gh | api
```

### 14.2 Project config

`.shipyard.yaml`

```yaml
repo: orchestra
base_ref: main
checks:
  required:
    - go test ./...
    - go vet ./...

docs:
  design_dirs:
    - docs/features
    - docs/design
    - docs/rfcs

policy:
  max_review_cycles: 3
  require_human_before_merge: true
```

---

## 15. CLI Surface

MCP is the primary interface, but a CLI makes debugging easier.

```bash
shipyard init
shipyard create-doc "Add Cursor backend" --repo orchestra
shipyard review-doc docs/features/cursor-backend.md --repo orchestra
shipyard approve <run-id>
shipyard ship docs/features/cursor-backend.md --repo orchestra
shipyard status <run-id>
shipyard next
shipyard fix-ci <run-id>
shipyard review-cycle <run-id>
shipyard merge-ready <run-id>
```

MCP tools can call the same core package used by CLI.

---

## 16. MVP Scope

### 16.1 MVP goal

Ship a local-first MCP server that can:

1. Track a workflow run for an existing task doc.
2. Ask Tower to create a worktree.
3. Launch a Cursor local agent in that worktree to implement the task doc.
4. Stream and persist agent events.
5. Help get a PR opened.
6. Run one agent review cycle.
7. Recommend next action.

### 16.2 MVP tools

Only build these first:

```text
ship_task_doc
get_workflow_run
list_workflow_runs
run_review_cycle
fix_ci
next_action
```

Add `create_task_doc` and `review_task_doc` after implementation path works.

### 16.3 MVP non-goals

Do not build yet:

- dashboard
- cloud runtime unless local runtime works
- auto-merge
- Slack integration
- generic DAG engine
- multi-user auth
- hosted service
- complex recipe marketplace

---

## 17. Implementation Milestones

### Milestone 1: Skeleton + storage

Deliverables:

- pnpm monorepo
- packages/shared with Zod schemas
- packages/store with SQLite schema
- CLI command `shipyard status`
- MCP server boots and lists tools
- no Cursor/Tower integration yet

Acceptance criteria:

- `pnpm test` passes
- MCP client can call `list_workflow_runs`
- SQLite state persists across runs

### Milestone 2: Tower adapter

Deliverables:

- Tower adapter through CLI or MCP
- `list_worktrees`, `get_worktree`, `add_worktree`, `sync`
- core service can create a worktree for a workflow run

Acceptance criteria:

- `shipyard ship <doc> --dry-run` shows intended Tower calls
- `shipyard ship <doc>` creates a Tower worktree and stores WorktreeRef

### Milestone 3: Cursor local runner

Deliverables:

- `@cursor/sdk` wrapper
- local run support with cwd = Tower worktree path
- event stream persisted as NDJSON
- implementation prompt generated from task doc

Acceptance criteria:

- Tool can launch Cursor agent in a worktree
- Stream events are saved
- Run status updates to completed/failed

### Milestone 4: PR handoff

Deliverables:

- GitHub/Tower sync after implementation
- PR creation support via agent prompt, GitHub adapter, or `gh` fallback
- PullRequestRef persisted

Acceptance criteria:

- A task doc can produce a branch/PR
- `get_workflow_run` returns PR URL and status

### Milestone 5: Review cycle

Deliverables:

- named reviewer configs
- reviewer prompt template
- `run_review_cycle` tool
- findings persisted
- max cycles policy enforced

Acceptance criteria:

- Review agent outputs structured findings
- Blocking findings trigger `addressing_feedback` state
- 3-cycle limit produces `needs_human`

### Milestone 6: CI fix

Deliverables:

- read CI status through Tower/GitHub
- `fix_ci` tool
- logs input if feasible
- CI attempt persistence

Acceptance criteria:

- Failing CI produces a Cursor fix run
- attempt count increments
- max attempts policy enforced

### Milestone 7: Next action planner

Deliverables:

- deterministic next-action rules
- global `next_action` tool
- CLI `shipyard next`

Acceptance criteria:

- Active workflow runs produce useful ranked recommendations
- recommendations include suggested MCP tool calls

### Milestone 8: Cloud runtime

Deliverables:

- Cursor cloud runner mode
- repo URL/start ref support
- reconnect/wait/get-run support
- branch/PR result extraction

Acceptance criteria:

- `ship_task_doc` can launch a cloud agent on a GitHub repo
- completed run returns PR URL or branch data when available

---

## 18. Testing Strategy

### 18.1 Unit tests

Test:

- state transitions
- next-action planner
- policy enforcement
- prompt rendering
- schema validation
- store round trips
- Tower adapter parsing
- Cursor event normalization

### 18.2 Integration tests

Use temporary git repositories and fake Tower/Cursor clients first.

Test flows:

```text
approved doc -> worktree_created
worktree_created -> implementing
implementation completed -> pr_opened
pr_opened + failing CI -> fixing_ci
review cycles hit 3 -> needs_human
ready_to_merge gating
```

### 18.3 Live/gated tests

Behind env flags:

```bash
SHIPYARD_LIVE_CURSOR=1
SHIPYARD_LIVE_TOWER=1
SHIPYARD_LIVE_GITHUB=1
```

Gated tests:

- launch real Cursor local run on test repo
- create real Tower worktree in sandbox repo
- create draft PR in test repo if safe

### 18.4 Golden tests

Use golden files for prompts:

```text
fixtures/prompts/implementation.golden.md
fixtures/prompts/review-correctness.golden.md
fixtures/prompts/ci-fix.golden.md
```

---

## 19. Security and Safety

### 19.1 Defaults

- Do not auto-merge by default.
- Do not delete worktrees automatically.
- Do not run more than 3 review/repair cycles by default.
- Require explicit human approval before merge.
- Store secrets only through env vars or existing system credential stores.
- Do not prompt-inject secrets into agent prompts.

### 19.2 MCP safety

MCP tools can perform real repo operations. Use conservative tool design.

Recommendations:

- Separate read-only tools from write tools.
- Return clear summaries before destructive operations.
- Require explicit arguments for merge/remove/escalate.
- For stdio MCP, assume local trust but still validate all paths.
- Do not accept arbitrary shell commands from tool inputs.
- Whitelist repo roots and worktree paths from Tower.

### 19.3 Path safety

- Never allow `docPath` outside registered repo root.
- Normalize and validate all paths.
- Reject `..` traversal.
- Resolve symlinks if writing artifacts.

### 19.4 Agent safety

- Prompt agents to stay within scope.
- Log raw events.
- Keep artifacts for audit.
- Never hide failed/partial agent attempts.
- Make human escalation a normal outcome, not a failure.

---

## 20. Design Doc Template

Use this template for task docs the system creates or expects.

```markdown
# <Feature / Task Name>

## Summary

One paragraph describing the desired change.

## Goals

- Goal 1
- Goal 2

## Non-goals

- Explicitly out of scope

## Current State

Describe the relevant current behavior/files/systems.

## Proposed Change

Describe the implementation shape.

## TDD / Test Plan

- Test to add/update first
- Expected failing behavior before implementation
- Expected passing behavior after implementation

## Implementation Tasks

1. Task one
2. Task two
3. Task three

## Acceptance Criteria

- [ ] Criterion one
- [ ] Criterion two
- [ ] Required checks pass

## Risks / Edge Cases

- Risk one
- Edge case one

## Review Focus

Ask reviewers to pay attention to specific areas.

## Commands

```bash
# required checks
```
```

---

## 21. Example End-to-End Flow

### 21.1 User prompt

```text
Use Shipyard to implement docs/features/cursor-sdk-workflow.md in the orchestra repo.
```

### 21.2 Agent calls MCP tool

```json
{
  "tool": "ship_task_doc",
  "arguments": {
    "repo": "orchestra",
    "docPath": "docs/features/cursor-sdk-workflow.md",
    "worktreeName": "cursor-sdk-workflow",
    "baseRef": "main",
    "runtime": "local",
    "autoCreatePR": true,
    "reviewAgents": ["correctness", "tests", "architecture"],
    "maxReviewCycles": 3,
    "runInitialReview": true
  }
}
```

### 21.3 Shipyard behavior

```text
1. Creates WorkflowRun.
2. Calls Tower add_worktree(repo=orchestra, name=cursor-sdk-workflow).
3. Reads task doc from new worktree.
4. Starts Cursor local agent in worktree path.
5. Saves Cursor stream events.
6. Agent implements doc.
7. Agent opens PR or Shipyard uses GitHub fallback.
8. Tower syncs PR/CI state.
9. Shipyard starts review cycle.
10. Review agents produce findings.
11. If blocking findings exist, implementation/fix agent addresses them.
12. Stops when green/approved or max cycles reached.
```

### 21.4 Example final response

```text
Workflow run ship_01HW... is ready for review.

Repo: orchestra
Branch: tower/cursor-sdk-workflow
PR: https://github.com/itsHabib/orchestra/pull/123
Status: agent_review
Review cycles: 1/3
CI: pending

Next action:
- wait for CI, then run fix_ci if failing or merge_when_green if approved.
```

---

## 22. Recipe System: Task Chains, Not Generic DAGs

Recipes are the eventual power layer, but they should be defined as **ordered compositions of named task units**, not arbitrary agent graphs.

The primitive is a **task**. A task is a concrete MCP-callable unit of work with a clear input schema, output schema, side effects, and state transition. Recipes are named chains of these task units.

This means:

```text
task = reusable workflow command
recipe = named sequence of tasks with policy and conditional gates
```

Examples of first-class task units:

```text
create_task_doc
review_task_doc
ship_task_doc
run_review_cycle
fix_ci
address_review_comments
next_action
escalate_to_human
merge_when_green
```

A recipe should mostly say: **run these tasks in this order, passing outputs forward, while enforcing these policies.**

### 22.1 Why this matters

Do not model recipes as free-form orchestration. That puts the project back into generic Orchestra territory too quickly.

Shipyard recipes should be opinionated macros over the same MCP tools a user or agent would call manually. The recipe runner should provide convenience, persistence, retry/stop behavior, and policy enforcement — not invent a second execution model.

Good mental model:

```text
Manual flow:
  create_task_doc -> review_task_doc -> ship_task_doc -> run_review_cycle -> next_action

Recipe flow:
  ship_feature = [create_task_doc, review_task_doc, ship_task_doc, run_review_cycle, next_action]
```

### 22.2 Task definition shape

A task unit should be represented internally as something like:

```ts
export interface TaskDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ZodSchema<I>;
  outputSchema: ZodSchema<O>;
  run(ctx: TaskContext, input: I): Promise<TaskResult<O>>;
}

export interface TaskResult<O> {
  status: "succeeded" | "failed" | "needs_human" | "skipped";
  output?: O;
  artifacts?: ArtifactRef[];
  nextSuggestedTask?: string;
  error?: string;
}
```

The MCP tools should mostly wrap task definitions. For example, the MCP tool `ship_task_doc` calls the internal `ship_task_doc` task.

### 22.3 Recipe definition shape

A recipe is a chain of task invocations. Start simple: sequential by default, optional conditions, and explicit output mapping. Avoid full DAG semantics until real usage proves the need.

Example: `ship_feature` recipe.

```yaml
name: ship_feature
version: 1
description: Create/review a task doc, implement it with Cursor, review the PR, and suggest the next action.

inputs:
  repo: string
  title: string
  initialPrompt: string
  baseRef:
    type: string
    default: main
  worktreeName:
    type: string
    optional: true

policy:
  maxReviewCycles: 3
  maxCiFixAttempts: 3
  requireDesignApproval: true
  requireGreenCi: true
  autoMerge: false

steps:
  - id: create-doc
    task: create_task_doc
    with:
      repo: "{{ inputs.repo }}"
      title: "{{ inputs.title }}"
      prompt: "{{ inputs.initialPrompt }}"

  - id: review-doc
    task: review_task_doc
    with:
      repo: "{{ inputs.repo }}"
      docPath: "{{ steps.create-doc.output.docPath }}"

  - id: ship-doc
    task: ship_task_doc
    with:
      repo: "{{ inputs.repo }}"
      docPath: "{{ steps.review-doc.output.docPath }}"
      worktreeName: "{{ inputs.worktreeName }}"
      baseRef: "{{ inputs.baseRef }}"

  - id: review-pr
    task: run_review_cycle
    with:
      workflowRunId: "{{ steps.ship-doc.output.workflowRunId }}"
      maxCycles: "{{ policy.maxReviewCycles }}"

  - id: next
    task: next_action
    with:
      workflowRunId: "{{ steps.ship-doc.output.workflowRunId }}"
```

### 22.4 Smaller recipe examples

`review_existing_pr`:

```yaml
name: review_existing_pr
version: 1
inputs:
  repo: string
  prNumber: number
policy:
  maxReviewCycles: 3
steps:
  - id: review
    task: run_review_cycle
    with:
      repo: "{{ inputs.repo }}"
      prNumber: "{{ inputs.prNumber }}"
      maxCycles: "{{ policy.maxReviewCycles }}"
  - id: next
    task: next_action
    with:
      repo: "{{ inputs.repo }}"
      prNumber: "{{ inputs.prNumber }}"
```

`repair_ci`:

```yaml
name: repair_ci
version: 1
inputs:
  repo: string
  prNumber: number
policy:
  maxCiFixAttempts: 3
steps:
  - id: fix
    task: fix_ci
    with:
      repo: "{{ inputs.repo }}"
      prNumber: "{{ inputs.prNumber }}"
      maxAttempts: "{{ policy.maxCiFixAttempts }}"
  - id: next
    task: next_action
    with:
      repo: "{{ inputs.repo }}"
      prNumber: "{{ inputs.prNumber }}"
```

### 22.5 Recipe MCP tools

Recipes should be exposed through MCP after the core task tools are stable.

Suggested tools:

```text
list_recipes
get_recipe
run_recipe
get_recipe_run
cancel_recipe_run
```

Suggested resources:

```text
shipyard://recipes
shipyard://recipes/{name}
shipyard://recipe-runs
shipyard://recipe-runs/{id}
```

### 22.6 Recipe run state

A recipe run should record each task invocation and its output.

```ts
export interface RecipeRun {
  id: string;
  recipeName: string;
  recipeVersion: number;
  status: "running" | "succeeded" | "failed" | "needs_human" | "canceled";
  inputs: Record<string, unknown>;
  policy: WorkflowPolicy;
  startedAt: string;
  endedAt?: string;
  steps: RecipeStepRun[];
}

export interface RecipeStepRun {
  id: string;
  task: string;
  status: "pending" | "running" | "succeeded" | "failed" | "needs_human" | "skipped";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
  startedAt?: string;
  endedAt?: string;
  error?: string;
}
```

### 22.7 MVP guidance

Do not build the recipe runner first. Build task tools first.

MVP order:

```text
1. Implement task units directly as MCP tools.
2. Use them manually in Cursor/Claude to validate the workflow.
3. Add `run_recipe` only once the task boundaries feel stable.
4. Start with sequential recipes.
5. Add conditionals only for obvious gates: CI failed, reviews approved, max cycles exceeded.
6. Avoid parallelism/DAG semantics until a real workflow needs it.
```

The first recipe to support should be `ship_feature`, and it should simply group the same task units Habib already uses manually.

---

## 23. Differentiation from Orchestra

Orchestra is a general agent workflow engine:

```text
agents + dependencies + artifacts + steering + MCP + observability
```

Shipyard should be a repo-task workflow tool:

```text
task doc + worktree + Cursor run + PR + review cycles + CI repair + merge readiness
```

The distinction:

- Orchestra primitive: agent/team node
- Shipyard primitive: repo work item

This distinction is essential. Do not let Shipyard become a generic orchestration framework unless it first succeeds as a workflow tool.

---

## 24. Potential Future Features

### 24.1 Dashboard

A dashboard could show:

```text
Workflow | Repo | Branch | PR | State | CI | Review cycles | Next action
```

### 24.2 Batch mode

Ship many task docs:

```json
{
  "tool": "ship_batch",
  "arguments": {
    "repo": "orchestra",
    "docs": [
      "docs/features/a.md",
      "docs/features/b.md",
      "docs/features/c.md"
    ],
    "parallelism": 3
  }
}
```

### 24.3 Migration mode

Run one migration across many repos.

```yaml
name: migrate-sdk-v4-to-v5
repos:
  - api
  - worker
  - frontend
policy:
  one_pr_per_repo: true
  max_review_cycles: 2
```

### 24.4 OpenTelemetry

Export events/spans:

- workflow started/completed
- Cursor run started/completed
- review cycle started/completed
- CI fix attempt
- human escalation

### 24.5 Skill sync

Generate `.cursor/skills/ship-task-doc/SKILL.md` so Cursor agents natively understand the workflow.

### 24.6 Tower deep integration

Eventually Tower could show Shipyard workflow status as another column:

```text
WORKTREE              PR       CI      REVIEWS       SHIPYARD
cursor-sdk-workflow   #123     ✓       changes req   cycle 2/3
```

---

## 25. Implementation Agent Instructions

If you are the agent implementing this project, follow these rules:

1. Build the MCP/server/core skeleton first. Do not start with a dashboard.
2. Do not reimplement Tower. Use Tower via MCP or CLI.
3. Do not build a generic DAG engine.
4. Keep the primitive as `WorkflowRun` / `RepoJob`, not `AgentNode`.
5. Persist everything important.
6. Make the next-action planner deterministic.
7. Default to human-before-merge.
8. Enforce max 3 review cycles.
9. Write tests for state transitions before wiring live Cursor SDK.
10. Keep live Cursor/GitHub tests gated behind environment flags.
11. Treat Cursor SDK API shape as beta; wrap it behind `CursorRunner` so changes are isolated.
12. Use TypeScript throughout.

---

## 26. First Implementation Prompt

Use this prompt to start coding the repo:

```text
We are building Shipyard, a TypeScript MCP server and CLI for Habib's agentic dev workflow.

Read docs/DESIGN.md first.

Implement Milestone 1:
- pnpm monorepo
- packages/shared with Zod schemas for WorkflowRun, WorkflowStatus, WorkflowPolicy, WorktreeRef, PullRequestRef, CursorRunRef, ArtifactRef, ReviewCycle, NextAction
- packages/store with SQLite persistence and migrations
- packages/core with deterministic state transition helpers and next-action planner
- packages/mcp-server with tools: list_workflow_runs, get_workflow_run, next_action
- packages/cli with commands: status, next
- tests for state transitions and next-action planner

Constraints:
- Do not integrate Cursor SDK yet.
- Do not integrate Tower yet.
- Do not build dashboard.
- Keep all external integrations behind interfaces.
- Use TypeScript, pnpm, Vitest, and Zod.
- Make `pnpm test` pass.
```

---

## 27. Second Implementation Prompt

```text
Implement Milestone 2: Tower adapter.

Add packages/tower-adapter.

It should expose:
- listRepos
- listWorktrees
- getWorktree
- addWorktree
- removeWorktree
- sync

Start with a CLI-backed adapter that shells out to `tower` and parses JSON if Tower supports JSON output. If Tower does not support JSON output, add a clear TODO and a fake adapter for tests.

Wire core service method `createTaskWorktree(workflowRunId, repo, name, baseRef)`.

Add MCP tool `create_task_worktree` if needed internally, but keep `ship_task_doc` as the preferred user-facing tool later.

Tests:
- fake Tower adapter creates WorktreeRef
- workflow transitions approved -> worktree_created
- path validation rejects worktrees outside registered repo root
```

---

## 28. Third Implementation Prompt

```text
Implement Milestone 3: Cursor local runner.

Add packages/cursor-runner.

Create CursorRunner interface:
- startRun
- getRun
- streamRun
- waitRun
- cancelRun
- followUp

Implement local runner using @cursor/sdk based on current Cursor SDK docs.

Wire MCP tool `ship_task_doc`:
- resolve workflow run or create one
- validate doc path
- create Tower worktree if absent
- render implementation prompt from task doc
- start Cursor local agent with cwd = worktree.path
- persist prompt and event stream
- update workflow status

Keep PR opening as a TODO if necessary; store implementation result summary first.

Tests:
- fake Cursor runner receives correct cwd and prompt
- event stream is persisted
- workflow transitions worktree_created -> implementing -> pr_opened or failed depending on fake result
```

---

## 29. README Pitch

Potential README opening:

```markdown
# Shipyard

Shipyard is an MCP toolkit for turning task docs into tracked Cursor-agent pull requests.

It is built for the workflow where you write a design/TDD doc, spin up a Tower worktree, let a Cursor agent implement it, ask multiple agents to review the PR, fix CI/comments for at most three cycles, and then merge when ready.

It is not a generic agent orchestration framework. It is a repo-native shipping workflow.
```

---

## 30. Open Questions

Implementation agent should resolve these early:

1. Does Tower CLI expose JSON output for worktrees/repos? If not, add it to Tower or call Tower MCP.
2. Does Cursor SDK local mode expose enough result metadata to know branch/PR artifacts, or do we need GitHub/Tower fallback?
3. What is the exact Cursor SDK cancellation/follow-up API shape as of implementation time?
4. Should PR opening be done by Cursor agent, GitHub adapter, or both?
5. How should review agents post comments: as GitHub comments, artifacts, or both?
6. Should cloud mode create branches/PRs directly, while local mode relies on `gh`?
7. Which MCP TS SDK version should be used: v1.x stable or v2 if stabilized by implementation time?
8. Should workflow state live globally only or also inside repo `.shipyard/`?
9. What fields can Tower provide about CI/reviews today through MCP?
10. Should `ship_task_doc` be sync-blocking until PR exists, or return immediately with a running workflow run?

Recommended MVP answer to #10:

- Return after Cursor run starts, with a run ID.
- Provide `get_workflow_run` and `next_action` for progress.
- Add an option `waitUntil?: "started" | "pr_opened" | "complete"` later.

---

## 31. Final Product Shape

If successful, Shipyard becomes the MCP tool Habib invokes when he wants to ship code with agents:

```text
Use shipyard to ship docs/features/x.md in orchestra.
```

The system then handles:

```text
doc -> worktree -> Cursor implementation -> PR -> agent reviews -> CI/comment repair -> ready to merge
```

This is valuable because it is not abstract orchestration. It is the actual daily workflow encoded as software.


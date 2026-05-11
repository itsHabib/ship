# Ship

A repo-native dev-workflow MCP toolkit. **Pre-implementation** as of 2026-05-06 — Phase 0 (Cursor SDK spike) and Phase 1 (monorepo scaffold) done; no package code yet. See [docs/features/ship-v1/plan.md](docs/features/ship-v1/plan.md) for what's next.

## Docs layout

- `docs/<topic>.md` — locally cached reference docs (external SDKs, protocols, specs).
- `docs/features/<feature>/spec.md` — design spec for that feature.
- `docs/features/<feature>/plan.md` — execution plan with phase checkboxes for that feature.

Start with the active feature's `spec.md`, then its `plan.md`. The plan tracks what's done and what's next.

## Develop

```
pnpm install
make check          # typecheck + lint + format-check + test
```

CI on `.github/workflows/ci.yml` runs the same `make check` matrix on ubuntu + windows. Lint/format/test rules live in `eslint.config.js`, `.prettierrc`, `vitest.config.ts`. TS strict knobs in `tsconfig.base.json`.

## How Ship fits

- `../tower` owns repos, worktrees, PR/CI/review snapshots. Ship calls it; Ship doesn't reimplement it.
- `@cursor/sdk` owns coding-agent execution.
- Ship owns workflow state, persistence, and the MCP surface above the other two.
- inspired by lessons learned from ../orchestra ../cortex

## Development workbench

Ship doesn't run alone — it's one node in a three-MCP workbench that turns "I want to ship X" into "here's the PR + here's the durable trail." When a Claude (or Cursor, or human) starts work in this repo, reach for these in this order:

| MCP | What it owns | When to reach for it |
|---|---|---|
| **`dossier`** | Project → phases → tasks ledger + artifact links | Plan a feature; record what's claimed / running / done; bind a PR url back to the task that produced it |
| **`tower`** | Repo registration + git worktrees | Spin up an isolated `.worktrees/<name>` on a fresh `tower/<name>` branch for an agent (or human) to work in without disturbing the main checkout |
| **`ship`** | Workflow execution + durable run state | Hand a task doc to a coding agent (`mcp__ship__ship`), poll `get_workflow_run`, cancel via `cancel_workflow_run`, inspect history via `list_workflow_runs` |

### The loop

1. **Dossier** — record the work: `project_create` (once per feature), `phase_add` (once per stage of the feature), `task_create` (once per shippable unit). Tasks are where chips / phase docs land in the ledger.
2. **Tower** — spin up the workspace: `register_repo` (once per repo), then `add_worktree` per task. Branch defaults to `tower/<name>`, path to `<repo>/.worktrees/<name>`.
3. **Task doc** — write `docs/features/<feature>/phases/<NN>-<slug>.md` inside the worktree with the standard sections (Status / Owner / Scope / Functional / Tradeoffs / EDs / Validation / Risks / Out of scope / Implementation plan). Commit + push the branch.
4. **Ship** — `mcp__ship__ship({ workdir: <worktree-abs-path>, docPath: <task-doc>, repo: <name>, branch: tower/<name> })`. Returns `{ workflowRunId, status: "running" }` (V1 actually blocks until terminal — see `phases/08-mcp-server.md § Risks` for the timeout caveat; poll `get_workflow_run` if the MCP request times out). Inspect the diff in the worktree; iterate or accept.
5. **PR** — push, open with the standard 3-reviewer trigger (Copilot via `gh pr edit --add-reviewer copilot-swe-agent`, `@codex review`, `@claude review`).
6. **Dossier** — `task_complete <id>` + `artifact_link` to bind the merged PR url back to the task. Future audits of "what landed and why" start from Dossier.

### Why three MCPs and not one

Each layer is independently swappable:

- Dossier could be GitHub Projects, Linear, or a Notion DB — it owns "what needs doing" and "what's done." Ship doesn't care which substrate.
- Tower could be plain `git worktree`, a cloud Cursor agent, or a Codespace — it owns "where work happens." Ship doesn't care.
- Ship owns "drive an agent against a workdir + persist what happened" and *only* that. It doesn't choose the workdir, doesn't open PRs, doesn't update the project tracker.

Capabilities-not-implementations: substituting any one of the three doesn't ripple into the other two. A future cloud Tower replacement, a different task tracker, or a non-Cursor agent runner all plug in at their own seam.

Not every flow uses all three. A quick one-off can skip Dossier; an existing-checkout edit can skip Tower; a non-agent change skips Ship. The workbench is a menu, not a checklist.

## Shipping Features
Follow this general workflow for implementing a feature
- implement said feature
- create a branch if you haven't already
- create a PR
- request copilot as reviewer
- comment "@codex review"
- comment "@claude review"
- ensure CI is green
- ensure review comments are addressed
  - it's ok to be opinionated, don't have to take all comments blindly
- repeat the review cycle 3 times before reaching out
- when ready to merge reach out

## Agent commit trailers

When an agent emits a canonical `Co-authored-by:` trailer as part of its commit flow, include it on every agent-authored commit. This makes agent provenance auditable via `git log` without inspecting branches or PR descriptions — a recurring need as Ship-on-Ship dogfooding ramps and a single feature may have commits from multiple agents.

Trailers seen in this repo:

- **Claude Code** → `Co-Authored-By: Claude <model-name> <noreply@anthropic.com>` (emitted automatically when Claude commits on the operator's behalf — `<model-name>` is filled in with whichever Claude version is active, e.g. `Claude Opus 4.7 (1M context)`).
- **Cursor agents** (via `@ship/cursor-runner` → `@cursor/sdk`) → `Co-authored-by: Cursor <cursoragent@cursor.com>` (added by the Cursor SDK during a `ship` run).

Agents that don't emit a trailer as part of their standard commit flow aren't required to invent one — skipping is fine. Human-authored commits don't need a trailer. Trailer casing varies across agents; that's expected and not a thing to fix — GitHub's attribution resolution is case-insensitive, and `git log -i --grep` handles both variants.

## PR sizing

Target weighted-LOC bands per PR:

| Band | Limit |
|---|---|
| amazing | < 500 |
| ideal | < 700 |
| stretch | < 1000 |

Weights:

- production source (incl. JSDoc) + SQL + bash: **1.0×**
- tests + fixtures: **0.5×**
- lockfiles, generated, configs (`tsconfig.json`, `vitest.config.ts`, `package.json` boilerplate), docs: **0×**

A phase task doc declares the weighted budget in a **Scope** section near the top (right after `Status` / `Owner` / `Date`). If the budget exceeds 700, the doc must either split into multiple phase docs OR justify the no-split inline (tightly coupled state machine, single SQL schema you can't ship half of).

The phase doc's "Implementation plan" step list is the natural PR boundary. When there are more than ~3-4 distinct steps, treat each step (or small group) as its own PR — not as substeps inside one PR. Reviewers flag a wrong-shape budget at design time, not after a 1500-LOC PR is open.
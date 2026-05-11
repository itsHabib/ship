# Ship

A repo-native dev-workflow MCP toolkit. **V1 feature-complete on `main`** as of 2026-05-10 — Phases 0–9 shipped; both `@ship/cli` and `@ship/mcp-server` are runnable; Ship-on-Ship dogfooding has landed real PRs (#19, #21). See [docs/features/ship-v1/plan.md](docs/features/ship-v1/plan.md) for status and what's next (V2 surfaces: PR opening, review cycles, async-mode `ship` tool).

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

Three MCP tools work together to turn "I want to ship X" into "here's the PR + durable trail." When the signal matches, **just call the verb**. Don't ask permission.

### dossier — project memory

Long-term home for what's planned, in-flight, and shipped. Projects → phases (design docs) → tasks → artifacts (PRs / commits / files).

Use proactively for:

- *"What's the state of `<project>`?"* → `project.get { slug }`, then `phase.list` + `task.list { project: <slug>, status: in_progress }`.
- *"I'm starting `<new chunk of work>`."* → `phase.add { project, slug, title, body }`.
- *"I need to do X"* / discrete actionable surfaces → `task.create { project, phase?, slug, title, body }` (status defaults to `todo`).
- User picks up a task → `task.claim { id, actor: human:michael }`. Re-claim by same actor is a no-op.
- Progress / state transition on a task → `task.update { id, status?, note?, ... }`. Append notes liberally — the corpus *is* the working log.
- Open / merged PR, commit ties to a task → `artifact.link { project, task?, kind, ref, label }` without being asked.
- *"Done with task X."* → `task.complete { id, note? }`.

Don't use for:

- Code-level work (write the code first; *then* `artifact.link` the PR).
- Anything that lives only in this session's scratch context.

### tower — workspace substrate

Owns repo registration + git worktrees. Each agent / human task gets its own isolated workspace so the main checkout stays clean and parallel work doesn't collide.

Use proactively for:

- *"Starting `<branch / feature>`."* → `tower.add_worktree { repo, name }`. Branch becomes `tower/<name>`; path becomes `<repo>/.worktrees/<name>`.
- New repo Tower doesn't know yet → `tower.register_repo { path }` (defaults name to dir basename).
- *"What worktrees are open?"* → `tower.list_worktrees { repo? }` — includes PR / CI / review state.
- Worktree done + PR merged → `tower.remove_worktree { repo, name }` to clean up the local clone.

Don't use for:

- Editing files inside the worktree (that's a normal file edit, not a Tower call).
- Anything in the main checkout — Tower's job is the *isolated* workspace.

### ship — workflow execution

Hands a task doc to a coding agent, persists what happened, lets you inspect / cancel / replay. Owns nothing about the workspace (Tower's job) or the planning (Dossier's job).

Use proactively for:

- *"Ship `<task doc>` against `<worktree>`."* → `ship.ship { workdir, docPath, repo, branch }`. V1 blocks until terminal; if the MCP request times out, the workflow continues durably — poll `ship.get_workflow_run { workflowRunId }`. See [phases/08-mcp-server.md § Risks](docs/features/ship-v1/phases/08-mcp-server.md) and the V2 async-mode discussion.
- *"What ran on `<repo>` recently?"* / *"What's still in flight?"* → `ship.list_workflow_runs { repo?, status?, limit? }`.
- *"What did `<wf id>` do?"* → `ship.get_workflow_run { workflowRunId }` (also accessible via the `ship://runs/{id}` resource).
- An in-flight run needs to stop → `ship.cancel_workflow_run { workflowRunId }` (idempotent on terminal rows).

Don't use for:

- Creating the worktree (Tower).
- Writing the task doc (a normal file edit inside the worktree).
- Recording the result back to project state (Dossier `artifact.link`).

### The loop

Most features go through all three in order:

1. **Dossier** — `project.create` (once per feature), `phase.add` (one per stage), `task.create` (one per shippable unit).
2. **Tower** — `tower.register_repo` (once per repo), then `tower.add_worktree` per task. Branch = `tower/<name>`, path = `<repo>/.worktrees/<name>`.
3. **Task doc** — write `docs/features/<feature>/phases/<NN>-<slug>.md` inside the worktree (Status / Owner / Scope / Functional / Tradeoffs / EDs / Validation / Risks / Out-of-scope / Implementation-plan). Commit + push.
4. **Ship** — `ship.ship` against the worktree + doc. Poll `get_workflow_run` if the MCP request times out. Inspect the diff; iterate or accept.
5. **PR** — push, open, request reviewers (Copilot via `gh pr edit --add-reviewer copilot-swe-agent`; `@codex review`; `@claude review`).
6. **Dossier (close)** — `task.complete { id, note }` + `artifact.link` to bind the merged PR url back to the task.

### Why three MCPs and not one

Each layer is independently swappable. Dossier could be GitHub Projects, Linear, or a Notion DB — it owns "what needs doing." Tower could be plain `git worktree`, a cloud Cursor agent ref, or a Codespace — it owns "where work happens." Ship owns "drive an agent against a workdir + persist what happened" and only that. Substituting any one doesn't ripple into the other two.

Not every flow uses all three. A one-off CLI fix can skip Dossier; an existing-checkout edit can skip Tower; a non-agent change skips Ship. The workbench is a menu, not a checklist — but when the signals above match, default to calling the verb without checking in first.

## Shipping Features
Follow this general workflow for implementing a feature
- implement said feature
- create a branch if you haven't already
- create a PR
- request Copilot as reviewer via REST: `gh api -X POST repos/<owner>/<repo>/pulls/<n>/requested_reviewers -f 'reviewers[]=Copilot'` (do NOT use `gh pr edit --add-reviewer copilot-swe-agent` — it silently no-ops). Verify with `gh pr view <n> --json reviewRequests`.
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
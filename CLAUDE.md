# Ship

A repo-native dev-workflow MCP toolkit. **V1 feature-complete on `main`** as of 2026-05-10 — Phases 0–9 shipped; both `@ship/cli` and `@ship/mcp-server` are runnable; Ship-on-Ship dogfooding has landed real PRs (#19, #21). See [docs/features/ship-v1/plan.md](docs/features/ship-v1/plan.md) for status and what's next (V2 surfaces: PR opening, review cycles, async-mode `ship` tool).

## Docs layout

- `docs/<topic>.md` — locally cached reference docs (external SDKs, protocols, specs).
- `docs/features/<feature>/spec.md` — design spec for that feature.
- `docs/features/<feature>/plan.md` — execution plan with phase checkboxes for that feature.

QE SDET test-layer taxonomy (L1–L4, bug-smash cadence) lives in [`docs/features/qe-sdet/spec.md`](docs/features/qe-sdet/spec.md) — linked here so contributors find the harness philosophy without duplicating it into this file.

Start with the active feature's `spec.md`, then its `plan.md`. The plan tracks what's done and what's next.

## Develop

```
pnpm install
make check          # typecheck + lint + format-check + test
```

CI on `.github/workflows/ci.yml` runs the same `make check` matrix on ubuntu + windows. Lint/format/test rules live in `eslint.config.js`, `.prettierrc`, `vitest.config.ts`. TS strict knobs in `tsconfig.base.json`.

Subagents live in `.cursor/agents/`. See [docs/features/ship-v2/phases/03-subagent-passthrough.md](docs/features/ship-v2/phases/03-subagent-passthrough.md) for the rationale.

## How Ship fits

- `../tower` owns repos, worktrees, PR/CI/review snapshots. Ship calls it; Ship doesn't reimplement it.
- `@cursor/sdk` owns coding-agent execution.
- Ship owns workflow state, persistence, and the MCP surface above the other two.
- inspired by lessons learned from ../orchestra ../cortex

> **Per-feature phase-doc convention** (ship-specific, lives outside the dev-workbench block on purpose so `/dev-workbench` re-runs don't overwrite it): every dossier task that fires `ship.ship` must have a `docs/features/<feature>/phases/<slug>.md` written first — **named, not numbered** (phase numbers proved unhelpful; use a descriptive slug like `cloud-docpath-remote-source.md`). Each contains Status / Owner / Scope / Functional / Tradeoffs / EDs / Validation / Risks / Out-of-scope / Implementation-plan. The dossier task body is a registry pointer; the phase doc is the contract. Existing `NN-*.md` docs are historical — leave them; don't mass-renumber. See "## Session workflow" below.

<!-- BEGIN dev-workbench (managed by /dev-workbench skill — re-run to refresh; hand-edits inside this block will be overwritten) -->
## Dev workbench

Several MCP servers + skills are available in any Claude session on this machine — the dev-workflow infrastructure built across the portfolio. **This is ship — the workflow-execution plane itself** — so the ship verbs are the most directly relevant when working in this repo, alongside dossier (project memory), huddle (multi-seat coordination), and the `/worktree-*` skill family for git worktrees. When the signal matches, **just call the verb**. Don't ask permission.

Dogfood reality: ship runs cursor against ship's own task docs when iterating on ship-the-codebase — every PR shipped here passes through a ship run (now driven by the `ship driver` engine) at least once.

### dossier — project memory

Long-term home for what's planned, in-flight, and shipped across the portfolio. Projects → phases (design docs) → tasks → artifacts (PRs / commits / files). Markdown-on-disk corpus; the on-disk format IS the source of truth.

**Use proactively for:**

- *"What's the state of `<project>`?"* → `mcp__dossier__project_get { slug }`, then `mcp__dossier__phase_list` + `mcp__dossier__task_list { project, status: ["in_progress"] }`.
- *"I'm starting `<new chunk of work>`."* → `mcp__dossier__phase_add { project, slug, title, body }`.
- *"I need to do X"* / discrete actionable surface → `mcp__dossier__task_create { project, phase?, slug, title, body }` (status defaults to `todo`).
- User picks up a task → `mcp__dossier__task_claim { id, actor: "human:michael" }`. Re-claim by same actor is a no-op.
- Progress on a task → `mcp__dossier__task_update { id, status?, note?, ... }`. Append notes liberally — the corpus IS the working log.
- Open / merged PR → `mcp__dossier__artifact_link { project, task?, kind: "pr"|"commit", ref, label }` without being asked.
- *"Done with task X."* → `mcp__dossier__task_complete { id, note? }`.

**Don't use for:**

- Code-level work (write the code first; *then* `artifact_link` the PR).
- Anything that only matters within this session's scratch context.

### ship — workflow execution

Hands a task doc to a coding agent (cursor), persists what happened, lets you inspect / cancel / replay the run. Owns nothing about the workspace (the `/worktree-*` skills handle that) or the planning (dossier's job).

**Use proactively for:**

- *"Ship `<task doc>` against `<worktree>`."* → `mcp__ship__ship { workdir, docPath, repo, branch }`. V2-async — returns `{ workflowRunId, status: "running" }` immediately.
- *"Ship `<task doc>` on cursor cloud (no local worktree)."* → `mcp__ship__ship { docPath, runtime: "cloud", cloud: { repos: [{ url }] } }`.
- *"What ran on `<repo>` recently?"* / *"What's still in flight?"* → `mcp__ship__list_workflow_runs { repo?, status?, limit? }`.
- *"What did `<wf id>` do?"* → `mcp__ship__get_workflow_run { workflowRunId }` (also accessible via the `ship://runs/{id}` resource).
- In-flight run needs to stop → `mcp__ship__cancel_workflow_run { workflowRunId }` (idempotent on terminal rows).

**Don't use for:**

- Creating the worktree (use `/worktree-add`).
- Writing the task doc (a normal file edit inside the worktree).
- Opening a PR — that's `gh pr create` directly (or the future `gh` MCP shim per `pers/mcp-workstation/gh-shim`). Ship's job ends at agent-run terminal state; PR creation is downstream.
- Recording the merged PR back to project state (dossier `artifact_link`).

**Cursor built-in subagents:** Cursor also ships implicit subagents — `Explore` (codebase search), `Bash` (shell command isolation), and `Browser` (DOM-snapshot filtering) — that load automatically without files in `.cursor/agents/`. Do not redefine them in this repo. Per-subagent `model:` frontmatter in `.cursor/agents/` (e.g. `composer-2-fast` for mechanical checks, `opus-high` for reasoning-heavy roles) falls back to `inherit` when the configured model isn't on the operator's plan — check `events.ndjson` `task` tool_call args if cost optimization doesn't appear to apply.

### huddle — multi-agent / multi-seat coordination

Spins up a Slack channel + per-seat keys so multiple agents (or agent + human) can share a working context without polluting any one session's chat. Each "seat" gets a key it uses to post / read; the orchestrator (huddle creator) has full access via `huddleId`.

**Use proactively for:**

- *"Set up a coordination channel for `<purpose>` with `<N>` agents."* → `mcp__huddle__huddle_create { purpose, orchestrator: { id, displayName }, seats: [{ id, displayName }, ...], ttlHours? }`. Returns per-seat keys + Slack channel id.
- *"What huddles are open?"* → `mcp__huddle__huddle_list { active: true }`.
- *"Post an update into huddle `<id>`."* → `mcp__huddle__huddle_post { huddleId, body, key?, replyTo? }`. Orchestrator omits `key`; seats include their key.
- *"Catch up on the channel."* → `mcp__huddle__huddle_read { huddleId?, key?, since?, limit? }`.
- Done → `mcp__huddle__huddle_close { huddleId }` (archives the Slack channel + marks done).

**Don't use for:**

- One-off agent runs that don't need cross-agent coordination — just ship the task and read the events log.
- Long-term project memory (dossier owns that).

### playwright — browser automation

Headless / headed browser control via Playwright. Use when an agent task genuinely needs to interact with a web UI (login flow, scraping rendered DOM, screenshotting a page state) rather than hitting an API.

**Use proactively for:**

- *"Open `<url>` and check `<element>`."* → `mcp__plugin_playwright_playwright__browser_navigate { url }` then `..._browser_snapshot` (returns the accessibility tree) or `..._browser_take_screenshot`.
- *"Fill `<form>` and submit."* → `..._browser_fill_form { fields: [...] }` then `..._browser_click { ref }`.
- *"Capture network requests during `<flow>`."* → `..._browser_navigate` + `..._browser_network_requests` after the action.
- *"Run JS against the page."* → `..._browser_evaluate { code }`.

**Don't use for:**

- API testing — use `curl` / `gh` / a real HTTP client.
- Anything where the page is server-rendered and could be fetched via `WebFetch` instead.
- Tasks where the operator's actual Chrome session is needed (use the claude-in-chrome MCP for that — separate tier).

### `/work-driver` — drive agent-led impl end-to-end

Drives one or N parallel streams to merge through the `ship driver` engine: the engine owns dispatch → poll → judgment → land, and the skill owns prep, the review cycles, and the merge call. Reads a manifest produced by `/work-driver-prep` (the common case), or resolves dossier task IDs / a phase directly.

**Triggers:** "drive this impl work", "run this through ship", "fire N parallel streams", "ship and merge", explicit `/work-driver`.

**Pair with:** `/work-driver-prep` when you have a batch of dossier tasks and want one spec doc per task + conflict-aware batching before fanning out.

### `/work-driver-prep` — spec docs + batched plan from a backlog of tasks

Takes a list of dossier tasks (or a phase slug) and emits one spec doc per task plus a structured `driver.md` manifest grouping the specs into parallel-safe batches. Removes the manual gap between "I have N todo tasks" and "I can invoke `/work-driver`."

**Triggers:** "ship the open follow-ups", "fan these tasks out", "prep work-driver", "set up the hygiene PRs", explicit `/work-driver-prep`.

**Pair with:** `/work-driver` (consumes the emitted manifest).

### `/shipped` — retrospective recap of a chunk of work

Backward-looking on what merged, forward-looking on what's available next. Pulls ground truth from a `/work-driver` manifest when one's present (`docs/features/*/driver.md` with `merged_at` in frontmatter), falls back to `gh pr list` / `git log --merges` / dossier `task_list` against a `--since` window otherwise. Output sections: `## Shipped` (merged PRs + weighted-LOC + dossier closures), `## What changed about main` (new capabilities the operator can reach today), `## Open` (todo / chips / stale in_progress), `## Next moves` (1-3 concrete recs).

**Triggers:** "what just shipped", "what did we ship", "what merged today", "post-run summary", "what now", explicit `/shipped`.

**Pair with:** `/work-driver` as the natural end-of-run recap. Distinct from `/status` — `/status` is in-flight; `/shipped` is retrospective on landed work.

### `/status` — tight in-flight status update

Four sections, hard 1-3 sentence cap each: `## What happened` (concrete outcomes since last update), `## What's next` (1-2 immediate moves), `## What I recommend` (one specific rec + reason), `## What I need from you` (blocking asks only). Skips empty sections rather than padding. Operator-facing, not process narration.

**Triggers:** "give me an update", "status", "where are we", "sitrep", "summarize the situation", explicit `/status`.

**Pair with:** `/shipped` for the post-run version. `/status` is the mid-flight ping; `/shipped` is the retrospective.

### `/worktree-*` — manage secondary git worktrees

Thin skill family over plain `git worktree`. Use these instead of reaching for an MCP — they cover the verbs that mattered (add, list, remove, transfer, where) without an external state store. Default convention: branch name is user-chosen (no forced prefix); path is `<repo>/.claude/worktrees/<branch>/`.

- **`/worktree-add`** — *"spin up a worktree for <ticket>"* → creates `.claude/worktrees/<branch>/`, copies untracked CLAUDE.md if present
- **`/worktree-list`** — *"what worktrees do I have"* → branch, dirty state, optional PR/CI from `gh`
- **`/worktree-remove`** — *"clean up the worktree"* → dirty-state aware (commit-WIP / stash / discard)
- **`/worktree-transfer`** — *"bring this work over to main"* → removes secondary, checks out branch in root
- **`/worktree-where`** — *"where am I"* → which worktree, branch, and cwd this session is pointing at

### The loop

A typical end-to-end flow when working on any portfolio repo:

```
mcp__dossier__task_create        # plan: discrete shippable unit
       │
       ▼
/worktree-add <branch>           # isolate: own branch + dir under .claude/worktrees/
       │
       ▼
(write the spec doc inside the worktree, commit, push)
       │
       ▼
mcp__ship__ship { workdir, docPath, repo, branch }    # dispatch cursor against the spec
       │     │
       │     └─ /work-driver coordinates the rest if multiple streams:
       │        poll → land → PR → review cycles → merge → cleanup
       ▼
gh pr create + request reviewers (Copilot + @codex + @claude)
       │
       ▼
gh pr merge --squash --admin --delete-branch     # remote-only delete
       │
       ▼
mcp__dossier__task_complete + mcp__dossier__artifact_link { kind: "commit", ref }
       │
       ▼
/worktree-remove                                  # local cleanup (or /worktree-transfer to drain into root)
```

Steps 3-7 of this loop are exactly what `/work-driver` automates when you fan multiple streams in parallel.

### Why this shape

Each layer is independently swappable. Dossier could be Linear or GitHub Projects — it owns "what needs doing." The `/worktree-*` skills could be hand-rolled `git worktree` calls or a Codespace driver — they own "where work happens." Ship could be a different agent runner (Claude Code SDK, a local cursor subprocess, etc.) — it owns "drive an agent against a workdir + persist what happened." Huddle owns multi-seat coordination channels; playwright owns browser. Substituting any one doesn't ripple into the others.

Not every flow uses every tool. A one-off CLI fix can skip dossier; an existing-checkout edit can skip the worktree skills; a non-agent change skips ship. The workbench is a menu, not a checklist — but when the signals above match, default to calling the verb without checking in first.
<!-- END dev-workbench -->

## Session workflow

When to use what during a feature session — extends "The loop" above:

- **Design phase (no Ship).** When the phase doc IS the deliverable, Ship doesn't fire — but the doc still goes up as its own PR with reviewers requested (per the operator's `feedback_design_doc_inline.md` memory entry): the reviewer bots review the design so the operator doesn't have to do it manually. Scale reviewer count to doc size per `feedback_reviewer_count_by_pr_size.md`.
- **Impl phase (work-driver pattern).** When the phase doc is the INPUT — `mcp__ship__ship { workdir, docPath, repo, branch }` produces the implementation. The same driver pattern handles one stream or N parallel: fast-forward or rebase each worktree to `origin/main`, fire `mcp__ship__ship` per stream, poll terminal, commit + push (cursor doesn't auto-commit), open PR, coordinate review cycles per "Shipping Features" below, merge in dep order. Invoke `/work-driver` to load the codified steps — single-stream runs use the same loop with the merge-order step trivially no-op.
- **One-off fixes (skip the workbench).** A typo, doc-drift, quick chip — direct commit on a short-lived branch. No Dossier, no Ship.

If you maintain a work-driver friction log (operator-specific corpus, e.g. `pers/work-driver.md` outside this repo), append at least one entry per session. The log is the source corpus for skill iteration and `pers/mcp-workstation/` tool POCs; contributors without that corpus can skip this step.

## Shipping Features
Follow this general workflow for implementing a feature
- implement said feature
- create a branch if you haven't already
- create a PR
- request Copilot as reviewer: `gh pr edit <N> --add-reviewer @copilot`. `gh pr view <n> --json reviewRequests` may be `[]` immediately — Copilot clears `requested_reviewers` on accept and account-level auto-review can do the same; empty does **not** mean the app is missing or the request was dropped. Confirm with `gh api repos/<owner>/<repo>/issues/<n>/timeline --jq '.[] | select(.event == "review_requested" or .event == "copilot_work_started")'` or, after a couple of minutes, `gh api repos/<owner>/<repo>/pulls/<n>/reviews --jq '.[] | select(.user.login == "copilot-pull-request-reviewer")'`. Fallback if the new form errors on a specific repo: `gh api -X POST repos/<owner>/<repo>/pulls/<n>/requested_reviewers -f 'reviewers[]=Copilot'` (expect HTTP 201). Nuance: `feedback_copilot_reviewer.md` (memory).
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

## Git staging

Never use broad `git add` — no `git add -A`, `git add --all`, or `git add .`. Stage explicit paths (`git add path/to/file`). Broad-add sweeps in untracked / gitignore-missed junk: on 2026-05-29 a `git add -A` staged a `.keys~` credentials backup (a vim backup of the gitignored `.keys`) and only GitHub push protection caught it mid-push. Enumerating the files you mean to commit IS the safety check. (A PreToolUse hook to hard-enforce this was tried and rejected — it false-positives on any command that merely quotes a broad-add form, e.g. a PR body or commit message mentioning `git add .`. This is an agent-discipline rule, not a guardrail to automate.)

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

<!-- BEGIN eng-philo (managed by /eng-philo — re-run to refresh; hand-edits inside this block will be overwritten) -->
## Engineering principles

How code is written here — Dave Cheney lineage ([Practical Go](https://dave.cheney.net/practical-go)): simplicity, clarity, line-of-sight. Apply on every change; the lint below catches the slips.

1. **No `else` — line-of-sight.** Handle errors / edge cases with early returns and guard clauses; keep the happy path un-indented, flowing down the left margin. Reaching for `else` → return early instead.
2. **Shallow nesting — ≤2 levels *per scope*.** A `for` + an `if` is the ceiling in one scope. The budget is per-scope, not per-function — a closure / anon fn is its own scope, so a `for`+`if` inside a closure is fine. Deeper in one scope → extract a function.
3. **Policy vs mechanism.** Separate the decisions (policy: validation, state machines, business rules) from the plumbing (mechanism: persistence, transport, I/O). Mechanism is dumb and swappable; policy lives in a layer above it. Never let policy leak into a mechanism layer.
4. **Composition of single-responsibility layers.** Each layer / package owns ~one responsibility; the app is a *composition* of them; any piece is swappable without rippling into the others. Dependencies flow one direction.
5. **Small, sharp APIs.** Export the least callers need. Intention-revealing names. Accept the narrowest input, return concrete types. Make the zero value useful.
6. **Errors are values; simplicity over cleverness.** Handle or propagate errors explicitly — never swallow. Readable > clever > short. A little copying beats a premature abstraction or dependency.

### Node / TS idioms + enforcement

Early-return; no nested ternaries; no `else` after `return`; narrow exported surface.

*Enforce:* eslint — `complexity`, `max-depth`, `no-else-return`, `sonarjs/cognitive-complexity`.
<!-- END eng-philo -->
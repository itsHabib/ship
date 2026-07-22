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

These MCPs, planes, and skills are available in any agent session on this machine; the harness injects each tool's signature, so this is the *map* — how they compose — not the per-verb manual. When the signal matches, call the verb; don't ask permission. Stuck on a *knowledge* question about another portfolio repo → `/consult` its steward; only *authority* questions (direction, spend, irreversible calls) go to the operator. **This is ship — the Execution plane itself** (the driver engine), so its verbs are the most directly relevant here.

**MCPs (in-session):**
- **dossier** — durable project memory: projects → phases → tasks → artifacts (markdown-on-disk).
- **ship** — the driver engine: dispatch a task to a cloud/local agent and persist the run (dispatch→poll→judgment→land→record); inspect/cancel/replay.
- **huddle** — *optional* multi-seat coordination (Slack-backed); off the normal PR path.
- **playwright** — browser automation when a task needs a real DOM.

**Planes (CLIs, composed via exit codes + JSONL — not MCPs):**
- **gate** — authorization: evaluates the *exact* PR head, emits governed-path merge authorization. Findings ≠ authorization; gate is the merge boundary.
- **flare** — notification: best-effort escalation sink over authoritative receipts → its own Slack app/channel. Pure sink; never gates; not built on huddle.

**Skills:**
- **/work-driver** [+ **/work-driver-prep**] — drive agent-led impl end-to-end; prep builds the specs + conflict-batched plan.
- **/pr-risk** — size how much review a PR needs (deterministic floor + agent advisory); upstream of the reviewers — it decides *how much*, they *do* it.
- **/review-coordinator** [+ **/review-digest**] — consolidate the AI PR reviewers into one verdict (the judge over the finders); digest pre-triages the bot pile locally.
- **/shipped** · **/status** · **/wip** — retrospective recap · in-flight update · cross-store live board.
- **/consult** — summon a sibling repo's steward for a same-turn answer; knowledge → peer, authority → operator.
- **/worktree-*** — add · list · remove · transfer · where, over `git worktree`.

### The loop

```
dossier task → /worktree-add → spec → ship driver (cloud-first: dispatch→poll→judgment→land→record)
   → PR + CI → /pr-risk tiers it → reviewers fire → /review-coordinator → one verdict
   → gate evaluates the exact head → governed-path authorization → merge
   → authoritative receipts → dossier close-out → /worktree-remove
        ↘ any attention/terminal receipt → best-effort flare sweep → Slack   (independent; never gates)
```

`/work-driver` coordinates dispatch→poll→land and runs its own review triage inline. `/pr-risk` and `/review-coordinator` are steps you *invoke* — the driver→pr-risk / driver→coordinator wiring is planned, not built, so nothing here auto-delegates.

### Why this shape

Each layer owns one responsibility and is swappable without rippling: dossier owns *what needs doing*; worktree skills own *where work happens*; ship owns *drive an agent + persist the run*; pr-risk owns *how much review*; review-coordinator owns *consolidate the finders* (the bots are swappable under it); **gate owns *authorization* — is this exact head allowed to merge — which is not the reviewers' findings**; **flare owns *notification* — a best-effort sink on authoritative receipts, its own Slack app, never blocking the driver, never depending on huddle**; consult owns the stuck path; huddle owns optional multi-seat; playwright owns browser. The workbench is a menu, not a checklist — skip what a flow doesn't need.

### The shape underneath

These tools instantiate the redesign's five contract planes — coupled only by typed artifacts (`evidence → verdict → action`), never call stacks:

- **State** (remembers) — dossier + run/verdict/grant/receipt artifacts; the append-only substrate.
- **Execution** (does) — ship's driver; emits evidence, never judges itself.
- **Verification** (judges) — the escalate-only ladder (deterministic floor → local → premium), monotone `worst`/`max`: gate's reducer, review-coordinator, sense/triage/tracelens.
- **Capability** (bounds) — scoped/timed grants; every effectful verb needs a live grant + a supporting verdict.
- **Observability** (explains) — read-only, storeless views from State: flare, /wip, /shipped, /status.

This section is the sixth — **Composition**: the agent + thin policy choosing which planes a task needs. The boundaries above *are* the plane laws, not conventions.
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
- comment "@cursor review" — Cursor Bugbot no longer auto-fires (account-level auto-review was disabled 2026-07-22); request it explicitly like the others (alias: `bugbot run`). The `.ship.json` panel already lists cursor as `trigger: "mention"`, so ship-driven runs post this automatically; this line is for hand-driven PRs.
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
<!-- local-offload:start -->
## Local-first offload

Before spending cloud tokens on a mechanical sub-step, check for a free local path (needs the `local` CLI / Ollama on this machine):

- Narrowing a big file list, extracting structure from noisy tool output, shallow classification -> `/offload`
- "Have we solved/decided this before?" questions about the operator's own work -> `/ask-portfolio`
- Triaging a PR's bot-comment pile -> `/review-digest <PR#>`

Deep judgment (code review, risk calls, dense-diff reasoning) stays with the primary model. If `local` is not on PATH, skip silently -- never block on this.
<!-- local-offload:end -->

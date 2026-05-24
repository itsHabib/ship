# Remove `open_pr` from Ship

Status: design + impl (one PR)
Owner: itsHabib
Date: 2026-05-24

## Scope

**Weighted-LOC budget:** ~1700 weighted (~3000 raw, mostly deletion). **Over stretch (>1000), with no-split justification below.** One PR.

Per [CLAUDE.md](../../../CLAUDE.md) "## PR sizing", a PR exceeding 700 weighted must either split or justify inline. Justification accepted by operator:

- **Pure deletion.** No behavioral additions to review. Reviewer scans for file deletions and verifies `git grep open_pr` returns only the workflow-schema tombstone hits.
- **Tightly-coupled feature.** The verb, support service, errors, schemas, persistence, fixtures, and L4 e2e suite form one indivisible unit. Splitting forces dead-export intermediate states (e.g. orphan `OpenPrInput` exports after the service is gone but before the schemas drop).
- **Single review cycle** keeps coordination overhead low for what is fundamentally a "delete-this-feature" change.

## Summary

The `open_pr` MCP verb (shipped V2 phase 02, PR [#32](https://github.com/itsHabib/ship/pull/32) design / PR [#33](https://github.com/itsHabib/ship/pull/33) impl) is removed wholesale. Ship's scope shrinks inward: opening a PR is downstream of ship's job. Ship's job is "drive a coding agent against a task doc and persist what happened"; pushing branches and calling Octokit doesn't belong here.

PR creation moves to a future `gh` MCP shim — catalogued in `pers/mcp-workstation/` as the planned fifth workbench MCP. Until that shim lands, operators use `gh pr create` directly per the "Shipping Features" loop already documented in [CLAUDE.md](../../../CLAUDE.md).

This is **pure deletion**. No replacement surface in this repo. Cursor cloud's `autoCreatePR` field (an SDK-level passthrough to Cursor's own cloud-side PR creation) is unrelated and stays.

## What gets removed

### Files fully deleted

- `packages/core/src/{open-pr,git-remote,gh}.ts` and their `.test.ts` siblings — the service + git/forge shell-out implementations
- `packages/cli/src/commands/open-pr.ts` + `packages/cli/test/open-pr-command.test.ts` — the `ship open-pr <id>` subcommand
- `packages/mcp-server/src/tools/open-pr.ts` + `.test.ts` — the MCP tool registration
- `packages/test-harness/src/open-pr.ts` + `.test.ts` — shared open-pr test harness
- `e2e/scenarios/{open-pr,idempotent-open-pr,open-pr-failure-paths,ship-then-open-pr}.e2e.test.ts` — L4 live scenarios
- `e2e/integration/open-pr.integration.test.ts` — integration test against the Octokit boundary
- `e2e/fixtures/open-pr-sandbox/` — fixture repo content (renamed: see below)
- `docs/features/ship-v2/phases/02-open-pr.md` — the original design doc

### Renamed (because the fixture + helpers were shared with cloud tests)

- `e2e/scenarios/live-open-pr-helpers.ts` → `e2e/scenarios/live-cli-helpers.ts` (prune open-pr-only exports, keep generic subprocess + env + polling helpers)
- `e2e/fixtures/open-pr-sandbox/` → `e2e/fixtures/live-sandbox/`
- `OPEN_PR_FIXTURE` → `LIVE_SANDBOX_FIXTURE`
- `hasOpenPrLiveEnv()` → `hasLiveEnv()`

The cloud test suite (`cancel-live-ship`, `cloud-cancel-during-creating`, `cloud-happy-path`, `cloud-auto-create-pr-false`, `cloud-resume`, `cloud-no-workdir`) uses these helpers/fixtures generically; the open-pr-flavored names lied about purpose. Renaming cleans the surface area in the same PR rather than leaving stale names as a follow-up.

### Boundary schemas

- `@ship/mcp` drops `openPrInputSchema` / `openPrOutputSchema` and the open_pr section.
- `@ship/workflow` drops `phaseOpenPrResultSchema` + `PhaseOpenPrResult` (no read path consumes them — `outputJson` is opaque at the schema boundary).
- `phaseKindSchema` **keeps** `"open_pr"` as a tombstone literal — the SQLite store may contain historical phase rows with `kind = "open_pr"` from prior runs; narrowing the enum would break Zod hydration of those rows. The literal carries a `// "open_pr" retained for historical row hydration (verb removed)` comment.

### Errors

`@ship/core/src/errors.ts` drops 11 open-pr-specific error classes: `ImplementPhaseNotSucceededError`, `WorkdirNotGitError`, `EmptyBranchError`, `BaseBranchUnresolvedError`, `OriginHeadUnsetError`, `OriginRepoUnresolvedError`, `BranchPushFailedError`, `GhAuthError`, `GhCreatePrFailedError`, `WorkflowRunStillActiveError`, `OpenPrAbortedError`. The `ActiveRunsRegistry` stays — `ShipService` still uses it for in-flight cursor-run cancellation; only the comment about coordinating with `OpenPrService` is removed.

### Default wiring

`@ship/core`'s `createDefaultOpenPrService` / `DefaultOpenPrServiceOpts` / `OpenPrServiceFactory` are removed. The shared-infra map (`SHARED_INFRA_BY_DB_PATH`) stays — `ShipService` callers still benefit from it for memoization across factory calls; the docstring loses the open-pr coordination paragraph.

### CLI + MCP-server wiring

Both binaries lose their `openPrFactory` plumbing. `program.ts`, `service.ts`, `format.ts`, `bin.ts`, `cli-harness.ts` (CLI side) and `server.ts`, `bin.ts`, `errors.ts`, `mcp-harness.ts`, `tools/ship.test.ts` (mcp-server side) lose their open-pr branches.

### Docs

- [CLAUDE.md](../../../CLAUDE.md) — drop the `"Open the PR for this run." → mcp__ship__open_pr` bullet from the ship MCP verbs list. The "Shipping Features" loop already documents `gh pr create` as the operator path; that stays.
- `docs/features/ship-v2/{spec.md, cursor-cloud-followups.md, phases/{03,04,06,08,09}-*.md}` — scrub open_pr references; rewrite F4 in phase 04 (cloud + explicit open_pr flow becomes "cloud's `autoCreatePR: true` is canonical").
- `docs/features/qe-sdet/{spec.md, phases/{01,02,03}-*.md}` — drop open_pr from surface list; retire L4 phase 01.
- `docs/{cursor-sdk-leverage.md, cursor-sdk-typescript.md, e2e-execution.md}` — scrub references; drop the "Run the open_pr L4 suite" section.
- `docs/features/ship-v1/spec.md:360` — leave as historical (V1 spec never included open_pr; reference remains as period-accurate context).
- `e2e/README.md` — drop the `open-pr-sandbox/` fixture listing.

## Why now

Ship's V2 design has been settling for ~10 days. The clearer the V2 surface gets, the more `open_pr` looks like scope creep:

- **Ship is environment-agnostic.** Ship doesn't manage worktrees, doesn't assume Tower, doesn't know about forges. Adding an Octokit dependency walks that back.
- **Samurai sword principle.** One sharp verb per tool. `ship` drives an agent; `get_workflow_run` / `list_workflow_runs` read state; `cancel_workflow_run` signals. `open_pr` doesn't compose with the others — it's a separate forge-side concern.
- **gh-shim is the right home.** A dedicated `gh` MCP can offer `pr_create`, `pr_status`, `pr_comments`, `issue_create`, etc. without ship growing a forge dependency. The operator's `pers/mcp-workstation/` catalogue lists `gh-shim` as a planned tool.

The cost of carrying the verb (and its 11 error classes, 2 shell-out modules, 5 e2e scenarios, 3-file test harness) outweighs its convenience while a proper `gh` MCP is being planned. Better to remove it cleanly than let it ossify.

## Validation

- `make check` (typecheck + lint + format-check + test) passes on the branch.
- `git grep -niE 'open_pr|openPr|open-pr|OpenPr' packages/ e2e/` returns only the workflow `phaseKindSchema` tombstone + its acceptance test. Any other hit is a missed reference.
- MCP server smoke: the registered tools list no longer contains `open_pr`.
- CLI smoke: `ship --help` no longer lists `open-pr`.

## Risks

- **Historical phase rows.** Operators with `kind = "open_pr"` rows in their SQLite store keep being able to read them via `get_workflow_run` / `list_workflow_runs` because the enum tombstone preserves Zod compatibility. New runs cannot create such rows.
- **Operators who used `mcp__ship__open_pr` in scripts.** None known; the verb was V2-only and dogfood-internal. If discovered post-merge, the operator can run `gh pr create` directly.
- **Doc drift in adjacent phase docs.** The Explore sweep found ~40 hits across 15 design docs. Each is scrubbed in this PR; any straggler turns up in the symbol-grep verification step.

## Out of scope

- Adding the `gh` MCP shim. That's a separate project (`pers/mcp-workstation/gh-shim`, idea-stage).
- Removing `CloudRunSpec.autoCreatePR`. That's a Cursor SDK passthrough — Cursor's cloud side handles PR creation when set; ship just forwards the flag. Unrelated to the removed verb.
- DB migration to drop historical `open_pr` phase rows. The tombstone strategy avoids the need.

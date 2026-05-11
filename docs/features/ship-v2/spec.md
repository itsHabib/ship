# Ship V2

Status: design draft. Phase 01 (async ship tool) is the first V2 phase under design.
Owner: itsHabib
Date: 2026-05-10

> **Companion docs.** [ship-v1/spec.md](../ship-v1/spec.md) is the V1 design spec — feature-complete on `main` as of 2026-05-10. V2 phases compose onto V1 without retroactively redesigning it; each phase lands as its own doc + PR under `phases/`.

## Summary

V2 is the set of phases that sit on top of V1's "drive an agent against a workspace + persist what happened" primitive. V1 explicitly punted PR opening, review cycles, CI repair, and a usable agent-callable surface for runs that exceed the MCP request timeout. V2 picks those up, one phase at a time, with each phase shippable independently.

The V1 dogfood loop (PRs [#19](https://github.com/itsHabib/ship/pull/19), [#21](https://github.com/itsHabib/ship/pull/21)) validated that the V1 primitive works end-to-end. It also surfaced one concrete blocker for agent-driven use: a typical `ship.ship` run takes 90–200s (PR #21 measured 126s), and the MCP request timeout for any tool call is ~60s. That makes the current `ship` MCP tool unusable from an agent without out-of-band fallback to `get_workflow_run` polling — the headline tool is a tripwire.

V2 phase 01 fixes that single thing. Subsequent V2 phases compose on top.

## Goals

- Make the MCP `ship` tool callable from a driver agent without falling out of the request budget.
- Keep V1's persistence and durability guarantees untouched. Runs are still recorded under one `WorkflowRun` row; cancellation still works; nothing about the substrate-agnostic runner changes.
- Add PR opening, review-cycle execution, and CI repair as new phases composing on the V1 `WorkflowRun` / `Phase` schema. Each phase = one new `Phase.kind` value + one new MCP tool (or a parameter to an existing one).
- Preserve the workspace-agnostic posture from V1 ED-3. V2 does not introduce a hard dependency on Tower or any specific workspace provider.

## Non-goals (V2)

- Streaming MCP responses (server-side incremental updates over the same request). Async-by-default + poll-via-`get_workflow_run` is V2's answer to long-running runs; SSE / progress notifications are deferred until we have a concrete client that needs them.
- Cloud Cursor runtime. Still deferred. The runner interface admits a cloud impl whenever someone files a phase doc for it; V2 doesn't.
- Recipes / the recipe runner / recipe MCP tools.
- Dashboard, web UI, multi-tenant features.
- Cross-repo coordination.

## Planned V2 phases

Each gets its own `phases/NN-...md` doc, reviewed and merged before implementation lands. Phase ordering reflects dependency, not priority.

1. **[01 — async ship tool](phases/01-async-ship-tool.md).** Change the `ship` MCP tool's return contract so it returns `{ workflowRunId, status }` immediately after the run is persisted, instead of awaiting the terminal state. CLI behavior is unchanged. This is the only V2 phase that strictly precedes the others — every later phase calls `ship` from an agent.
2. **02 — open_pr phase (planned).** New `Phase.kind = "open_pr"`. New MCP tool (likely `open_pr`) that pushes the branch and opens a PR via `gh pr create`. Composes on V1's `Phase` row; no schema migration. Out of scope for phase 01.
3. **03 — review-cycle phase (planned).** New `Phase.kind = "review"`. Drives a review agent against an open PR; persists the review run alongside the implement run.
4. **04 — CI-repair phase (planned).** New `Phase.kind = "ci_fix"`. Composes on PR + review; reacts to red CI by spawning a fix run, capped at N cycles.

Phase 01 is the only one in design today. Each later phase lands when its predecessor is reviewed + merged, not before.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Phase shape | Each V2 surface = one phase doc + one PR | One omnibus "V2 surfaces" PR | Matches V1's phase cadence; reviewers see one slice at a time; the 3-cycle review cap stays tractable. |
| Async ship before PR opening | Yes — phase 01 is async ship | PR opening first | PR opening needs to be callable from an agent. If `ship` can't be called from an agent today, neither can any later phase that fires it as a first step. Async ship is the smallest unblock. |
| Stream MCP responses | Deferred | Implement SSE / progress notifications | The async-return + poll story uses primitives every MCP client already supports. Streaming requires client-side support we'd have to validate per editor + per agent runtime, and the V1 dogfood worked with the polling shape already. |
| Cloud runtime | Deferred | V2 ships cloud cursor | Cloud adds repo-auth, polling-reconnect, lifecycle. The async-tool unlock is independent and ships in days; cloud is weeks. |

## Engineering decisions

### ED-1 — V2 phases compose on V1's `Phase` row, no schema migration

The V1 `phases` table already admits new `kind` values without ALTER. Every V2 surface (open_pr, review, ci_fix) adds a new `Phase` row to an existing `WorkflowRun`, not a new top-level entity. The state-machine helpers in `@ship/workflow` grow new transitions; the SQL schema doesn't.

### ED-2 — MCP tool surface grows; CLI mirrors selectively

Each V2 phase adds at most one MCP tool. The CLI mirrors only the surfaces that make sense for a human (e.g. `ship open_pr <run_id>` is plausible; `ship review` probably isn't). The MCP / CLI symmetry from V1 is not a constraint — V2 surfaces are agent-driven first; CLI parity is opportunistic.

### ED-3 — V1 contracts stay backward-compatible at the data layer, not at the MCP tool layer

A V1 `WorkflowRun` row read by V2 code must hydrate without migration. A V1-shape `ship.ship` tool *response*, on the other hand, may legitimately change shape in V2 — the V1 sync response was never usable from an agent anyway (60s timeout). Phase 01 defines exactly how that contract change is staged.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Async ship contract change breaks existing CLI / direct callers | V2 phase 01 regresses a working V1 path | CLI keeps the sync `ShipService.ship` path; only the MCP tool's outward contract changes. Phase 01 doc enumerates exactly which callers shift. |
| V2 phases couple to each other before any one ships | Review burden explodes | Strict per-phase docs + one-PR-per-phase rule. Phase 02+ docs land after 01's design lands. |
| Cloud runtime pressure leaks into V2 ahead of schedule | Scope creep | Keep the runner interface unchanged. Cloud lands as a new `CursorRunner` impl on its own phase, when someone files the doc. |

## Open questions

1. **Does `ship` get a new tool name or a new contract on the same name?** Phase 01 design discusses both. Default proposal: keep the name; change the contract; document the break in the changelog.
2. **Do V2 phases need a single umbrella `WorkflowRun` or multiple linked runs?** Default: single run, multiple `Phase` rows (per ED-1). Revisit only if a phase needs to outlive its parent run.

# Ship V2

Status: design draft. Phase 04 (cursor cloud runner) is the active V2 design phase; phases 01–03 are merged on `main`.
Owner: itsHabib
Date: 2026-05-10

> **Companion docs.** [ship-v1/spec.md](../ship-v1/spec.md) is the V1 design spec; the V1 implementation is feature-complete on `main` (V1 spec.md's own header still reads "design draft" — stale, tracked separately). V2 phases compose onto V1 without retroactively redesigning it; each phase lands as its own doc + PR under `phases/`.

## Summary

V2 is the set of phases that sit on top of V1's "drive an agent against a workspace + persist what happened" primitive. V1 explicitly punted PR opening, review cycles, CI repair, and a usable agent-callable surface for runs that exceed the MCP request timeout. V2 picks those up, one phase at a time, with each phase shippable independently.

The V1 dogfood loop (PRs [#19](https://github.com/itsHabib/ship/pull/19), [#21](https://github.com/itsHabib/ship/pull/21)) validated that the V1 primitive works end-to-end. It also surfaced one concrete blocker for agent-driven use: a typical `ship.ship` run takes 90–200s (PR #21 measured 126s), and the MCP request timeout for any tool call is ~60s. That makes the current `ship` MCP tool unusable from an agent without out-of-band fallback to `get_workflow_run` polling — the headline tool is a tripwire.

V2 phase 01 fixes that single thing. Subsequent V2 phases compose on top.

## Goals

- Make the MCP `ship` tool callable from a driver agent without falling out of the request budget.
- Keep V1's persistence and durability guarantees untouched. Runs are still recorded under one `WorkflowRun` row; cancellation still works; nothing about the substrate-agnostic runner changes.
- Add PR opening, agent-side self-review (via subagent passthrough), cloud runtime, and CI repair as new phases composing on the V1 `WorkflowRun` / `Phase` schema. Phase 01 changes `ship`'s return contract without adding a new `Phase.kind`. Phase 02 introduces `Phase.kind = "open_pr"` + the `open_pr` MCP tool. Phase 05 introduces `Phase.kind = "ci_fix"` + the `ci_fix` MCP tool. Phases 03 (subagent passthrough) and 04 (cursor cloud runner) plumb SDK capabilities through the runner without adding `Phase.kind` values or new MCP tools — they extend existing surfaces (subagents into the implement phase; the `cloud` runtime selector into `ship.ship`).
- Preserve the workspace-agnostic posture from V1 ED-3. V2 does not introduce a hard dependency on Tower or any specific workspace provider.

## Non-goals (V2)

- Streaming MCP responses (server-side incremental updates over the same request). Async-by-default + poll-via-`get_workflow_run` is V2's answer to long-running runs; SSE / progress notifications are deferred until we have a concrete client that needs them.
- Recipes / the recipe runner / recipe MCP tools.
- Dashboard, web UI, multi-tenant features.
- Cross-repo coordination.

## Planned V2 phases

Each gets its own `phases/NN-...md` doc, reviewed and merged before implementation lands. Phase ordering reflects dependency, not priority.

1. **[01 — async ship tool](phases/01-async-ship-tool.md).** Change the `ship` MCP tool's return contract so it returns `{ workflowRunId, status }` immediately after the run is persisted, instead of awaiting the terminal state. CLI behavior is unchanged. This is the only V2 phase that strictly precedes the others — every later phase calls `ship` from an agent.
2. **02 — open_pr phase (planned).** New `Phase.kind = "open_pr"`. New MCP tool (likely `open_pr`) that pushes the branch and opens a PR via `gh pr create`. Composes on V1's `Phase` row; no schema migration. Out of scope for phase 01.
3. **[03 — subagent passthrough](phases/03-subagent-passthrough.md).** Reframes the originally-planned "review-cycle phase." No new `Phase.kind`, no new MCP tool. `LocalCursorRunner` passes `local.settingSources: ["project"]` and an optional inline `agents` field to `Agent.create`, exposing Cursor SDK's subagent primitive end-to-end. The Ship repo dogfoods `.cursor/agents/code-reviewer.md`. Inner-loop review (catching issues before the PR opens) moves into the implement phase; outer-loop bot-reviewer coordination stays in the `parallel-driver` skill + `CLAUDE.md § Shipping Features`. The original AI-reviewer-phase idea is dissolved — see [phase 03 § Summary](phases/03-subagent-passthrough.md) for the reasoning.
4. **[04 — cursor cloud runner](phases/04-cursor-cloud-runner.md).** Introduces `CloudCursorRunner` as a second `CursorRunner` impl alongside `LocalCursorRunner`. `ship.ship` grows optional `runtime` + `cloud` fields for runtime selection; cloud runs use the same `Phase` rows + persistence as local. Lifts the cloud-runtime deferral V2 originally drafted with.
5. **05 — CI-repair phase (planned).** New `Phase.kind = "ci_fix"`. Composes on PR + review; reacts to red CI by spawning a fix run, capped at N cycles. Shape may revisit further once subagent-driven self-review lands and shows what's left for outer-loop CI repair.

Phase 04 (cursor cloud runner) is the only one in design today; phases 01–03 are merged on `main`. Each later phase lands when its predecessor is reviewed + merged, not before.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Phase shape | Each V2 surface = one phase doc + one PR | One omnibus "V2 surfaces" PR | Matches V1's phase cadence; reviewers see one slice at a time; the 3-cycle review cap stays tractable. |
| Async ship before PR opening | Yes — phase 01 is async ship | PR opening first | PR opening needs to be callable from an agent. If `ship` can't be called from an agent today, neither can any later phase that fires it as a first step. Async ship is the smallest unblock. |
| Stream MCP responses | Deferred | Implement SSE / progress notifications | The async-return + poll story uses primitives every MCP client already supports. Streaming requires client-side support we'd have to validate per editor + per agent runtime, and the V1 dogfood worked with the polling shape already. |
| Cloud runtime | Filed as phase 04 | Defer indefinitely | The original deferral reasoning was correct at the time (async-tool unlock was days; cloud is weeks; ship the smaller win first). With async-ship + open_pr + subagents now landed on `main`, cloud is the marginal unlock with the most remaining leverage. Phase 04 lifts the deferral with a single-impl scope (no resume, no artifacts — those are follow-up phases). |

## Engineering decisions

### ED-1 — V2 phases compose on V1's `Phase` row, no schema migration

The V1 `phases` table already admits new `kind` values without ALTER. V2 surfaces that introduce new state (`open_pr`, `ci_fix`) add a new `Phase` row to an existing `WorkflowRun`, not a new top-level entity. The state-machine helpers in `@ship/workflow` grow new transitions; the SQL schema doesn't. Phase 03 (subagent passthrough) is an exception: it fires inside the existing implement phase via SDK plumbing, so no new state machine and no new row.

### ED-2 — MCP tool surface grows; CLI mirrors selectively

Each V2 phase adds or modifies at most one MCP tool. (Phase 01 modifies `ship`'s return contract without adding a new tool; phases 03 and 04 add none — phase 03 plumbs the SDK's subagent surface inside the existing implement phase, phase 04 adds optional `runtime` / `cloud` fields to `ship.ship`; phases 02 and 05 each add one new tool — `open_pr`, `ci_fix`.) The CLI mirrors only the surfaces that make sense for a human (e.g. `ship open_pr <run_id>` is plausible; `ship ci_fix` probably isn't). The MCP / CLI symmetry from V1 is not a constraint — V2 surfaces are agent-driven first; CLI parity is opportunistic.

### ED-3 — V1 contracts stay backward-compatible at the data layer, not at the MCP tool layer

A V1 `WorkflowRun` row read by V2 code must hydrate without migration. A V1-shape `ship.ship` tool *response*, on the other hand, may legitimately change shape in V2 — the V1 sync response was never usable from an agent anyway (60s timeout). Phase 01 defines exactly how that contract change is staged.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Async ship contract change breaks existing CLI / direct callers | V2 phase 01 regresses a working V1 path | CLI keeps the sync `ShipService.ship` path; only the MCP tool's outward contract changes. Phase 01 doc enumerates exactly which callers shift. |
| V2 phases couple to each other before any one ships | Review burden explodes | Strict per-phase docs + one-PR-per-phase rule. Phase 02+ docs land after 01's design lands. |
| Cloud-runtime impl drifts from phase 04's design | Impl PRs introduce surfaces (resume, artifacts) the design deferred | Phase 04 doc's § Out of scope + § Risks enumerate the deferred surfaces explicitly. Impl PRs add only what the design admits; new scope opens a follow-up phase doc. |

## Open questions

1. ~~**Does `ship` get a new tool name or a new contract on the same name?**~~ **Resolved by [phase 01](phases/01-async-ship-tool.md) § Tradeoffs:** keep the name `ship`; change the return contract. The break is documented in the impl PR's changelog.
2. **Do V2 phases need a single umbrella `WorkflowRun` or multiple linked runs?** Default: single run, multiple `Phase` rows (per ED-1). Revisit only if a phase needs to outlive its parent run.

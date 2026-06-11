**Status**: shipped — PR #124 (squash `2253345`, 2026-06-10)
**Owner**: @michael
**Date**: 2026-06-09
**Related**: dossier phase `observability-run-diagnosis` (id: `phs_01KTJH6RW4DBEBNWA5D6N791FF`); locked design [docs/features/observability/spec.md](../spec.md) §6 (run-diagnosis surface), §7 (read path), §9 phase 2. **Closes feedback task** `failed-run-errormessage-omits-inflight-tool-call` (id: `tsk_01KT3CYEFSM41WS3VEQM5NMG0K`). **Depends on** P1 (all merged: #116 / #117 / #120).
**P1 validation gate (spec §9/§11)**: **PASSED** 2026-06-10 — deliberate e2e failure `wf_01KTT7F3NXG7A9TN2AANY7Z89K` (cloud, nonexistent `startingRef` → SDK `ConfigurationError`) classified `sdk-throw` and was diagnosed from `ship diagnose` + persisted category/`errorChain` alone, zero `events.ndjson` grep. (Synthetic provisioning failure; the in-flight-fallback categories accrue organic evidence on the next natural failure.)

# Run diagnosis surface — failureCategory on get_workflow_run, in-flight fallback, ship diagnose

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/mcp/src/mcp.ts` (schema field), `packages/core/src/service.ts` (getRun hoist), `packages/cursor-runner/src/_shared.ts` + `classify-failure.ts` (helper hoist + fallback), `packages/cli/src/commands/diagnose.ts` (new) + `format.ts` + registration | ~200 | 200 |
| Tests | mcp schema, core enrichment, _shared fallback table, CLI command (coverage gate forces branch-covering tests across 4 packages) | ~300 | 150 |
| **Total** | | | **~350** |

Band: **amazing, may stretch into ideal** (~350–500 with test drift). Single PR — steps 1+2 are validation-coupled (`workflowRunSchema` consumers are `.strict()`; core emitting a field the mcp schema lacks breaks parsing). **Contingency split if it balloons past ~700:** PR-A = steps 1–3 (surface + fallback; closes the feedback task), PR-B = step 4 (`diagnose` CLI, pure view layer).

## Goal

P1 persists `failureCategory` + bounded `failureDetail`, but nothing *surfaces* them: `get_workflow_run` callers must dig into `phases[]`, the dominant early-collapse failure mode still produces an opaque `errorMessage`, and there is no one-command diagnosis view. After this phase, a failed run is fully diagnosable from structured surfaces alone — no `events.ndjson` grep (spec §9 phase-2 goal).

## Behavior / fix (per locked design §6/§7)

1. **`failureCategory` on `get_workflow_run`** — `getWorkflowRunOutputSchema` gains `failureCategory: failureCategorySchema.optional()` (top-level, beside the post-#103 diagnostics fields). `core`'s `getRun` enrichment hoists it from the implement phase's persisted row — **read-only, no re-derivation** (spec §7 read path). Present iff the run is `failed` and a category was persisted; absent otherwise (notably: absent on `cancelled`, and on pre-P1 historical rows whose column is NULL). `phases[].failureCategory` continues to flow through unchanged.
2. **In-flight-tool-call fallback** (the feedback task) — `_shared.ts`'s `buildTerminalErrorMessage` currently folds in the last **error-bearing** tool_call or a status message; a run whose last tool_call is stuck `running` (the real 2026-06-02 failures: agent collapsed 2–6 min into a 30m cap mid-`make check`) gets a bare `SDK status ERROR after 6m (cap 30m)`. Add the lowest-priority detail source: when no failed tool_call and no status message exists, surface the last **running** (never-completed) tool_call. Target shape (from the field report):
   > `SDK status ERROR after 6m (cap 30m); last activity: shell 'make check' running 4m12s, never completed`

   Constraints an implementer must honor:
   - **Detection must be call_id-reconciled.** Hoist `lastRunningToolCall` + `finalStatusByCallId` (+ the timestamp helpers) from `classify-failure.ts` into `_shared.ts` and re-import them — `classify-failure.ts` already imports from `_shared.js`, so the import direction must stay one-way (`classify-failure` ← `_shared`); do **not** export from `classify-failure` into `_shared` (silent import cycle, no lint rule catches it).
   - **Command summary:** parse the tool_call event's `args` field defensively per [docs/cursor-sdk-typescript.md](../../cursor-sdk-typescript.md) (only `type`/`call_id`/`name`/`status` are stable; `args` is unknown-typed and may be flagged truncated). Use a string-valued command-like entry (e.g. `args.command`) when present, truncate the rendered summary to ~80 chars; tool-name-only is the floor **only when no usable args entry exists**. Apply the same summary helper inside `runningToolDetail` so the agent-collapse `failureDetail` matches the spec §7 example too.
   - **Age:** timestamp path only (`ts` deltas) — omit the age rather than fabricate it. Do **not** inherit `runningToolAgeMs`'s whole-run-`durationMs` fallback for this message (that fallback is correct for collapse *classification*; here it fabricates an age). `detailForAgentCollapse`'s existing age logic is otherwise unchanged this phase.
   - **Priority unchanged:** a non-empty `result.result` (agent's final text) still wins over everything; then failed tool_call > status message > **running tool_call (new)**. The fallback attaches only to the `SDK status X after Y` branch; the final `"Cursor SDK reported error without a message"` branch stays byte-identical.
   - P1's `agent-collapse-on-running-tool` detail only fires near the cap (>0.8×); this fallback covers the **early-collapse** case that classifies `unknown` — after it, `detailForUnknown`'s `rawErrorMessage` path naturally carries the in-flight info into `failureDetail` too.
3. **`ship diagnose <workflowRunId>` CLI** — new commander command (same shape as `status.ts`: `--json` flag, `cliExit` codes, `not found` on stderr). Renders the diagnosis fields in one view: terminal status, `failureCategory`, `errorMessage`, duration-vs-cap (`runDurationMs` / `maxRunDurationMs`), `sdkTerminalStatus`, last activity, `watchUrl` when present. Mechanism: calls the same `factory().getRun(...)` — a focused *view*, no new data path. Definitions:
   - **`errorMessage` is read from the implement phase row** (`phases[].errorMessage` — the same row the category hoist reads). The CLI digs; the output schema does **not** gain a top-level `errorMessage` (spec §6 adds only `failureCategory`).
   - **Last activity** = the most recent `tool_call` event in `recentEvents`, rendered `<name> <status>` (+ `ts` when present); fall back to the last event's `type` when no tool_call exists; omit the line entirely when `recentEvents` is absent.
   - Non-failed runs print the basic status view plus a `nothing to diagnose` note; `--json` emits the enriched `GetWorkflowRunOutput` as-is.

## Acceptance

- `get_workflow_run` on a failed classified run returns top-level `failureCategory`; absent for succeeded/cancelled/pre-P1 rows. No re-derivation (value equals the persisted phase row).
- A failed run whose last tool_call is `running` (no failed tool_call, no status message) yields an `errorMessage` naming the in-flight tool, **including the bounded command summary when the event's `args` carries a usable command-like entry** (e.g. `shell 'make check' running 4m12s, never completed`); tool-name-only is acceptable only when `args` has none. Running-age included iff event timestamps allow. Holds on both local and cloud paths (both use `buildTerminalErrorMessage`).
- Existing detail priority preserved: `result.result`, a failed tool_call, or a status message still wins over the running fallback (#103 parity); a running→completed call_id pair is not surfaced as in-flight.
- `ship diagnose <wf>` prints category + duration-vs-cap + errorMessage + last activity + watchUrl for a failed run; `--json` round-trips through `getWorkflowRunOutputSchema`; unknown id exits 1 with `not found`.
- `make check` (incl. coverage gate) green; no `_shared` ← `classify-failure` import edge.

## Test plan

- mcp: schema accepts/omits `failureCategory`; rejects invalid literals.
- core: getRun hoists category for a failed run; absent on succeeded + cancelled.
- _shared table: running-fallback message shape (with + without args command; with + without timestamps → age omitted); failed-tool_call-beats-running; status-message-beats-running; `result.result`-beats-all; running→completed pair not surfaced; no-events branch unchanged.
- cli: diagnose pretty + `--json` output; not-found exit; non-failed run note; last-activity render + omission.

## Non-goals

- Cross-run stats / `failureCategory` filter on `list_workflow_runs` (P3, stretch).
- A new top-level `failureDetail` or `errorMessage` output field — the bounded detail already rides in the phase row's `errorMessage` (`<category>; <detail>`); don't duplicate it (spec §6 adds only `failureCategory`).
- Re-deriving classification at read time, or backfilling categories for pre-P1 historical rows (their `failure_category` stays NULL; `diagnose` renders what exists).
- Changing `detailForAgentCollapse`'s age semantics (it keeps its P1 durationMs fallback — correct for near-cap classification).
- The secondary observation in the feedback task (concurrent local agents destabilizing each other) — cursor-SDK property, not a ship surface.

## Implementation plan

1. `@ship/cursor-runner`: hoist `lastRunningToolCall`/`finalStatusByCallId`/timestamp helpers into `_shared.ts`; add the bounded args-summary helper; running-tool_call fallback in `buildTerminalErrorMessage`; apply the summary in `runningToolDetail` (+ table tests).
2. `@ship/mcp`: `failureCategory` on `getWorkflowRunOutputSchema` (+ schema tests).
3. `@ship/core`: hoist persisted category in `getRun` diagnostics enrichment (+ tests).
4. `@ship/cli`: `diagnose` command + registration + format (+ tests).

Single PR (~350 weighted); steps are layers of one surface, not independent shippables. Contingency split seam documented in Scope.

# Cloud agent watch URL

Status: design draft
Owner: ship (cursor)
Date: 2026-05-29

> Origin: dossier `tsk_01KSS266FN9RQBKXN7KMFYFSJ0` (P2), surfaced during the roxiq pr-sanity browser-subagent dogfood 2026-05-29. Cross-linked: hooks-project task `ship-cloud-watch-url-posttooluse-hook` is a client-side stopgap (greps `events.ndjson` for the `bc-` id) — **this ship-native fix obsoletes it; close that hook task when this lands.**

## Scope

**Weighted LOC budget — ~250, "amazing" band, 1 PR.**

- `packages/workflow/src/workflow.ts` — `cursorWatchUrl(agentId)` pure helper + export.
- `packages/mcp/src/mcp.ts` — `getWorkflowRunOutputSchema` extends the run shape with optional `cursorAgentId` + `watchUrl`.
- `packages/core/src/service.ts` — `getRun` enriches the returned view: resolve the run's cloud cursor-run `agentId`, attach `cursorAgentId` + `watchUrl`. Absent for local runs / before an agent is recorded.
- `packages/mcp-server/src/tools/get-workflow-run.ts` + `resources/runs.ts` — no logic change (both already validate against `getWorkflowRunOutputSchema`); update the tool description to mention `watchUrl`.
- Tests: `cursorWatchUrl` unit; `getRun` enrichment (cloud → url present, local → absent, no-cursor-run-yet → absent); schema round-trip; one mcp-server tool assertion.

## Summary

The `bc-` Cursor agent id (the dashboard's addressing key) is persisted in `cursor_runs.agent_id` but reaches no consumer: `get_workflow_run`'s output (`workflowRunSchema`) carries only `phase.cursorRunId` — the `cr_` FK — never the resolved `CursorRunRef` with `agentId`. So today the only way to get the live link is to grep ship's local `events.ndjson` for `bc-...` and hand-build `https://cursor.com/agents/<bc-id>`.

This surfaces the link where consumers already look. `get_workflow_run` (and the `ship://runs/{id}` resource — same output schema) gains a top-level **`watchUrl`** (+ `cursorAgentId`) for cloud runs, resolved from the run's cloud cursor-run `agentId`. Null/absent for local runs and before the agent is recorded.

## Functional requirements

### F1 — `cursorWatchUrl` helper

Pure: `cursorWatchUrl(agentId: string): string` → `https://cursor.com/agents/${agentId}`. Lives in `@ship/workflow` (no deps, shared). One canonical URL shape; if Cursor's URL scheme changes, this is the single edit point.

### F2 — `get_workflow_run` output carries `watchUrl` + `cursorAgentId` (cloud only)

`getWorkflowRunOutputSchema = workflowRunSchema.extend({ cursorAgentId: z.string().min(1).optional(), watchUrl: z.string().url().optional() })`. `ShipService.getRun` resolves the run's cloud cursor-run `agentId` (the latest cloud `cursor_runs` row for the workflow) and attaches both. Local-runtime runs and runs with no cursor-run row yet → both fields absent (not null — strict-optional omit).

### F3 — domain entity stays pure

`watchUrl` is **derived presentation state, not durable** — it does not go on the domain `workflowRunSchema` / `WorkflowRun` (that stays a projection of stored rows). It's added only at the MCP output boundary, computed in `getRun`'s view assembly. Keeps `@ship/workflow`'s entity honest.

### F4 — tool description

`get_workflow_run`'s description notes the `watchUrl` field exists for cloud runs ("live Cursor dashboard link"), so consumers stop grepping events.

### F5 — `ship` tool result (deferred, not this phase)

The `ship` tool returns before the `bc-` agent id is necessarily recorded (async agent creation). Rather than block the return to wait for it, `watchUrl` is exposed via `get_workflow_run` only. If a cheap post-return read proves the id is reliably present by ship-return time, a follow-up can add it to the `ship` result too. Out of scope here.

## Engineering decisions

- **ED-1** — Top-level `watchUrl`, not per-phase. The `bc-` agent id is stable across a run's phases (resume re-attaches the *same* agent — phase-08 invariant), so "the run's watch URL" is well-defined. A consumer wants one link, not a dig through `phases[]`.
- **ED-2** — Derived at the MCP output boundary, not stored, not on the domain entity (F3). No new column, no migration.
- **ED-3** — Resolve from the latest cloud `cursor_runs` row for the workflow. Local cursor runs never produce a `watchUrl` (the local SDK agent id isn't a cloud dashboard target).
- **ED-4** — Absent (omitted), not `null`, when unavailable — matches the codebase's strict-optional convention.

## Validation

- **L1** — `cursorWatchUrl` shape test. `getRun` enrichment: cloud run → `watchUrl` + `cursorAgentId` present + correct; local run → both absent; cloud run with no cursor-run row yet → both absent. `getWorkflowRunOutputSchema` round-trips with + without the fields.
- **L2** — mcp-server `get_workflow_run` tool returns `watchUrl` for a cloud fixture run.
- Manual: fire a cloud `ship.ship`, call `get_workflow_run`, confirm `watchUrl` opens the right agent — no `events.ndjson` grep.
- `make check` green.

## Risks

- **URL scheme drift** — if Cursor changes `/agents/<id>`, the helper is the one edit point (F1). Low risk; `https://cursor.com/background-agent?bcId=<id>` is a documented alternate if `/agents/` is retired.
- **Multi-phase agent-id assumption** (ED-1) — if a future flow produces *different* `bc-` ids per phase, top-level "latest" is still a sane default, but per-phase exposure becomes the richer answer. Revisit only if that flow appears.

## Out of scope

- `ship` tool result `watchUrl` (F5 — deferred).
- Per-phase watch URLs (ED-1 — top-level is the right default now).
- Any change to how the `bc-` id is captured/persisted (it already is, in `cursor_runs.agent_id`).

## Implementation plan

Single PR (~250 weighted):

1. `cursorWatchUrl` helper + export + unit test (`@ship/workflow`).
2. `getWorkflowRunOutputSchema` extend (`@ship/mcp`) + round-trip test.
3. `getRun` view enrichment (`@ship/core`) — resolve latest cloud cursor-run `agentId`, attach fields + tests (cloud / local / no-run-yet).
4. `get_workflow_run` tool description update + one tool-level assertion.

## On merge

Close hooks-project task `ship-cloud-watch-url-posttooluse-hook` as obsolete (this is the native fix it was a stopgap for). Update roxiq memory `reference_cursor_watch_url.md` to point at `get_workflow_run.watchUrl` instead of the events.ndjson grep recipe.

# Phase 12 — Resume orchestration (startup scan + event-pump)

Status: design ready
Owner: ship (cursor)
Date: 2026-05-23

> Second of 3 sequential PRs implementing the phase 08 design. **Depends on [phase 11](11-attach-cloud-surface.md) merged first** — this PR uses the `CursorRunner.attach(...)` primitive that phase 11 ships. This PR wires up Ship-side orchestration: auto-resume on `ShipService` construction, per-run event-pump heartbeats, and the `ship.resumed` synthetic event for `events.ndjson` continuity. Dossier task: `tsk_01KSBJ3C5VS3WP26VN47JM3MQC` (`phase-8b-resume-orchestration`).

## Scope

**Weighted LOC budget — ~530, "ideal" band edge in 1 PR.**

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `core/src/service.ts` (resumeOrphanedRuns + activeRuns wiring) + new `core/src/cursor-runs/event-pump.ts` + `cursor-runner/src/cloud-runner.ts` (emit `ship.resumed`) + `core/src/artifacts/ndjson.ts` (append support if needed) | ~390 | 390 |
| Tests | `service.test.ts` (resumeOrphanedRuns paths) + `event-pump.test.ts` + `cloud-runner.test.ts` (ship.resumed emission) | ~280 | 140 |
| **Total** | | | **~530** |

If implementation reveals the production code is creeping past ~450 LOC, split the event-pump into its own PR ahead of `resumeOrphanedRuns` rather than blowing past the ideal band.

Files this phase touches:

- `packages/core/src/service.ts` — **MODIFY**: add `resumeOrphanedRuns()` method, call it from `createShipService`. Integrate with the existing `activeRuns: Map<workflowRunId, { controller }>` registry.
- `packages/core/src/cursor-runs/event-pump.ts` — **NEW**: background async task that owns a per-`cursor_run` event-forwarding + heartbeat loop. (Subdirectory chosen to mirror the existing `cursor_runs` table semantics.)
- `packages/core/src/cursor-runs/event-pump.test.ts` — **NEW**: unit tests for the pump's heartbeat + stop semantics.
- `packages/cursor-runner/src/cloud-runner.ts` — **MODIFY**: when `attach` succeeds, emit one synthetic `ship.resumed` event to `onEvent` BEFORE forwarding SDK stream events. (Phase 11 lands the `attach` method; this PR adds the synthetic-event emission inside it.)
- `packages/cursor-runner/src/cloud-runner.test.ts` — **MODIFY**: assert the `ship.resumed` event is emitted exactly once at the head of the stream.
- `packages/core/src/service.test.ts` — **MODIFY**: assert `resumeOrphanedRuns` queries the right rows, calls `attach` per row, handles `CursorAgentNotFoundError` by finalizing the row as failed, and is idempotent when re-run.
- `packages/core/src/artifacts/ndjson.ts` — **MODIFY** if needed: ensure `appendToNdjson(path, event)` exists and is used by the cloud-runner's `ship.resumed` emit path (likely already there; check before editing).

Out-of-scope files (handled by phase 13):

- `e2e/scenarios/cloud-resume.e2e.test.ts` — **phase 13**.

## Summary

Phase 11 ships the `attach` primitive. Phase 12 makes Ship use it automatically: when `ShipService` constructs (typically at process start), it scans the DB for cloud runs that were "running" at last shutdown and re-attaches each. The result: a Ship process that died mid-run will, on restart, transparently pick up where it left off — the cloud agent on Cursor's VM kept running, and Ship's events.ndjson gets a `ship.resumed` marker followed by the rest of the stream.

The event-pump owns the "keep ship's local state fresh while the cloud agent runs" loop. Without it, `workflow_runs.updated_at` would only bump when an MCP client is actively streaming; that's a bad UX for `list_workflow_runs` callers checking stale rows. The pump heartbeats every 30s on every running cloud run.

## Functional requirements

### F3 — Ship startup resume scan

On `ShipService` construction (eager — see ED-3):

1. Query: `SELECT id FROM cursor_runs WHERE status IN ('running','pending') AND runtime = 'cloud'`.
2. For each row: hydrate the `cursor_run` + parent `workflow_run` + parent `phase`. Reconstruct the `CursorRunAttachInput` from persisted state:
   - `agentId` / `runId` from `cursor_runs` columns.
   - `model` from `model_json`.
   - `cloud` spec from `phases.input_json` for the implement phase.
   - `mcpServers` from the same wiring layer used for fresh runs (NOT from the DB).
   - `agents` from the same wiring layer (NOT from the DB). Per spike Q2 + phase 08 ED-5: empirically `agents` survives `Agent.resume`, but we re-pass defensively so the `attach` path is symmetric with `run`.
3. Call `cloudCursor.attach(...)`.
4. Wire the resulting handle back into the same finalize path used by fresh runs (`finalizeSuccess` / `finalizeFailure` in `service.ts`).
5. If `attach` throws `CursorAgentNotFoundError` (per phase 11's F2/F6 mapping), finalize the row as `failed` with `errorMessage: "cloud agent <id> no longer reachable on resume"`.

Idempotent — re-running the scan on an already-attached cursor_run is a no-op via the `activeRuns` registry check (see ED-4).

### F4 — `events.ndjson` continuity with `ship.resumed` marker

When `attach` succeeds (inside `CloudCursorRunner.attach` — phase 11 lands the method, this PR adds the synthetic-event emit), the runner emits exactly one synthetic event to `onEvent` **before** forwarding SDK stream events:

```json
{ "type": "ship.resumed", "ts": "<RFC3339>", "agentId": "bc-...", "runId": "run-..." }
```

The artifacts layer (`packages/core/src/artifacts/ndjson.ts`) appends this to the existing `events.ndjson` for the run — no new file, no truncation. Per the operator preference captured in [cursor-cloud-followups.md § B](../cursor-cloud-followups.md#b--agentresume-for-cloud-runs-across-ship-process-restart), continuous log over branched log.

`ship.resumed` is reserved as a **Ship-internal event type** — distinct from any `type` cursor SDK emits. If the SDK ever introduces a `ship.*` type, this collides; rename then. Treated as a stable internal contract from here forward.

### F5 — Per-run event-pump

A background async task runs per `cursor_run.id` for any row with `status='running' AND runtime='cloud'`. Its job: keep `events.ndjson` and `workflow_runs.updated_at` fresh even when no MCP client is currently consuming the stream.

Shape:

- One task per cursor_run; identified by `cursor_run.id`.
- Wakes on stream events (the same `onEvent` callback `run` uses).
- Heartbeat-bumps `workflow_runs.updated_at` every **30s** (chosen for `list_workflow_runs` filter-by-stale to feel responsive without burning SQLite writes; concrete value tunable in impl).
- On terminal, runs the normal `finalizeSuccess` / `finalizeFailure` path.
- Stops cleanly on `cancel` (whether explicit or from `controller.abort()`).

Started for:

(a) Every freshly-fired cloud run — wire into `ShipService.runCloud` (or wherever `run` is called for cloud).
(b) Every resumed run from F3.

## Tradeoffs

(Inherited from [phase 08](08-agent-resume.md#tradeoffs). Slice-specific notes:)

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Resume trigger | `ShipService` constructor (eager) — phase 08 ED-3 | First `getWorkflowRun` call (lazy) | Eager means status is correct from t0 — `list_workflow_runs` doesn't need to special-case "this row says running but nobody's actually attached." |
| Events.ndjson shape | Append with `ship.resumed` marker | Branch `events.resumed.ndjson` | Tooling that reads events.ndjson keeps working unchanged. |
| Pump cadence | 30s heartbeat | 5s aggressive / 5min lazy | Polls every 30s is cheap on SQLite, fresh-enough for human-readable status, well under typical cloud-run length (10-30min). |

## Engineering decisions

(Inherited from [phase 08](08-agent-resume.md#engineering-decisions). The relevant EDs for this slice are ED-3, ED-4, ED-5.)

- **ED-3 — Resume scan runs at `ShipService` construction, not lazily.** `createShipService` already returns a Promise for migration setup; the resume scan joins that await chain. A pre-startup `cursor_runs` row count keeps the scan no-op when nothing to resume.
- **ED-4 — `activeRuns` registry guards re-resume.** Per-row check-and-set; if a `workflowRunId` is already in `activeRuns`, skip. Idempotent under concurrent `resumeOrphanedRuns` calls and safe if a manual `ship.ship` fires for the same row mid-scan.
- **ED-5 — `mcpServers` and `agents` re-passed from wiring, not from DB.** `mcpServers` is not persisted by the SDK; re-pass required. `agents` empirically survives `Agent.resume` (spike Q2, 2026-05-23) but is re-passed defensively so the `attach` path mirrors `run`.

## Validation plan

- **Unit (`ShipService.resumeOrphanedRuns`)** — fixture DB with N `running` cloud rows; assert N parallel `attach` calls via fake `CloudCursorRunner`; assert idempotent re-run (second invocation is a no-op via `activeRuns`).
- **Unit (`resumeOrphanedRuns` failure path)** — fake `attach` throws `CursorAgentNotFoundError`; assert the row finalizes as `failed` with the expected `errorMessage` and the parent `workflow_run.status` flips to `failed`.
- **Unit (event-pump)** — start a pump against a fake cursor_run; assert `updated_at` bumps every heartbeat tick; assert `cancel` stops it cleanly; assert terminal events run the right finalize path.
- **Unit (`cloud-runner.attach` ship.resumed emission)** — fake-SDK attach succeeds; assert `onEvent` receives exactly one `{ type: "ship.resumed", ... }` event before any SDK-forwarded events.
- **L2 scenario** — kill-mid-run scenario via `FakeCursorRunner.attach` + simulated process restart (no real cloud). Assert end-to-end: pre-restart row is `running`, post-restart row finalizes as `succeeded` with `ship.resumed` in `events.ndjson`.
- **`make check`** — full repo green.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Two Ship processes both resume the same row | Double-write to events.ndjson; race on terminal write-back | Single-process Ship assumption (already implicit). `activeRuns` registry guards within a process. Cross-process needs a SQLite advisory lock — explicit out of scope for this PR; document the constraint. |
| Heartbeat task leaks if `attach` fails before stream starts | Background tasks accumulate over startup-resume failures | Construct the pump task INSIDE `attach`'s success path only; on failure throw before pump start. Test asserts no pump task created on attach failure. |
| `events.ndjson` concurrent write from the dying-then-resumed Ship | Two writers could trample lines | Resume only fires when no process is currently holding the row (resume scan happens at fresh startup; the dead process by definition has no writers). Single-process-at-a-time invariant carries. |
| `ship.resumed` event type collides with a future SDK type | Downstream consumers mis-classify | Reserved as a Ship-internal type; rename if SDK ever ships a `ship.*` namespace. Treated as stable forward-compat from here. |
| Production source creeps past ~450 LOC | Stretches the ideal band toward stretch (>700) | Split the event-pump into its own PR ahead of `resumeOrphanedRuns` if it grows past the ideal-band threshold — flag in the implementation plan if it happens. |

## Out of scope

- L3 end-to-end scenario test (real cloud, kill-mid-run + restart) — **phase 13**.
- Cross-process SQLite advisory lock for multi-Ship coordination — single-process invariant preserved; document only.
- Manual `ship.attach` MCP tool — no external use case yet.
- Persisting `mcpServers` in the DB — re-passing from wiring per ED-5; no schema change.
- Resume of failed / cancelled runs — scan filter is `status IN ('running','pending')` only.
- Cloud agent retention window probe (Q4) — deferred to longer-window observation.

## Implementation plan

Single PR. Step list = commit boundaries (split into a follow-up PR if implementation reveals the ideal-band stretch noted in Scope).

1. **`ship.resumed` synthetic event emit.** Modify `CloudCursorRunner.attach` (from phase 11) to emit one `{ type: "ship.resumed", ts, agentId, runId }` event to `onEvent` before forwarding SDK events. Update `cloud-runner.test.ts` to assert this. **Validation:** `pnpm --filter @ship/cursor-runner test cloud-runner` green.

2. **Event-pump.** New `packages/core/src/cursor-runs/event-pump.ts` exporting `startEventPump({ cursorRunId, onEvent, db, intervalMs })` and `stopEventPump(pumpHandle)`. Unit tests in `event-pump.test.ts`. **Validation:** `pnpm --filter @ship/core test event-pump` green.

3. **`ShipService.resumeOrphanedRuns` impl.** Query + hydrate + attach loop in `service.ts`. Integrate with `activeRuns` registry. Wire into `createShipService` await chain. Unit tests in `service.test.ts`. **Validation:** `pnpm --filter @ship/core test service` green.

4. **L2 scenario.** Add an `L2` scenario (under `test-harness/scenarios/` if that's the convention; else in `service.test.ts`) for the kill-mid-run path using `FakeCursorRunner.attach`. **Validation:** scenario passes.

5. **`make check`.** Full repo green.

## Cross-refs

- Overall design: [`08-agent-resume.md`](08-agent-resume.md) — F3, F4, F5, ED-3, ED-4, ED-5.
- Spike findings: [`pers/cursor-sdk-resume-spike/findings.md`](../../../../cursor-sdk-resume-spike/findings.md) — Q2 informs ED-5 nuance.
- Predecessor: phase 11 (`11-attach-cloud-surface.md`) — ships the `attach` primitive this PR uses.
- Successor: phase 13 (`13-l3-resume-scenario.md`) — end-to-end test that exercises this orchestration against real cloud.
- Dossier task: `tsk_01KSBJ3C5VS3WP26VN47JM3MQC` (`phase-8b-resume-orchestration`).

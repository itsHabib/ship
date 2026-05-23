# Phase 08 — `Agent.resume` across Ship-process restart

Status: design draft
Owner: ship (cursor)
Date: 2026-05-22

> Predecessor: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md) (`CloudCursorRunner`) + [06-cloud-fix-arc.md](06-cloud-fix-arc.md). Trigger: [cursor-cloud-followups.md § B](../cursor-cloud-followups.md#b--agentresume-for-cloud-runs-across-ship-process-restart). This is a **design-only PR**; impl follows in its own phase after the open questions below are resolved (likely via a small SDK spike).

## Scope

**Design PR — doc only.** No code, no schema migration in this PR. The doc establishes the contract; the impl phase is the follow-up.

When implemented (separate phase, target stretch band ~1000 weighted LOC):

- `packages/cursor-runner/src/runner.ts` — `CursorRunner.attach(...)` interface method.
- `packages/cursor-runner/src/cloud-runner.ts` — `attach` impl using `Agent.resume` + `Agent.getRun`.
- `packages/cursor-runner/src/local-runner.ts` — `attach` either unimplemented-by-design or throws `LocalResumeNotSupportedError` (see ED-2).
- `packages/cursor-runner/src/errors.ts` — `CursorAgentNotFoundError`, `LocalResumeNotSupportedError`.
- `packages/core/src/service.ts` — `ShipService.resumeOrphanedRuns()` called on construction; per-run event-pump worker.
- `packages/store/src/cursor-runs.ts` — likely no schema change (`agent_id`, `runtime`, `model_json` already there). Maybe an additive `last_pumped_at` column for backoff bookkeeping (TBD by impl phase).
- `e2e/scenarios/cloud-resume.e2e.test.ts` (gated on `SHIP_LIVE` + `SHIP_CLOUD`).

## Summary

Today, when the Ship process dies mid-run, the cloud agent on Cursor's VM **keeps running**, but Ship loses all visibility into it: no terminal write-back, no events.ndjson appends past the death, `WorkflowRun.status` is permanently stuck at `running` until manually patched. The work isn't lost — it's just unrecoverable through Ship.

Cursor SDK's [`Agent.resume(agentId, { apiKey })`](../../cursor-sdk-typescript.md#resuming--listing--inspecting) re-attaches by ID, and `Agent.getRun(runId, { runtime: "cloud", agentId })` retrieves the in-flight `Run` so a fresh stream can be opened. Ship already persists `cursor_runs.agent_id` and `cursor_runs.runtime` — that's the recovery key.

This phase designs the surface: `CursorRunner.attach(...)` as the cross-runtime contract, `ShipService` startup scan that auto-resumes every `status IN ('running','pending') AND runtime='cloud'` row, append-to-existing-events.ndjson with a synthetic `resumed_at` marker event so the on-disk log is continuous, and a per-run event-pump task so `get_workflow_run` polling sees fresh state even when no MCP client is currently streaming.

## Functional requirements

### F1 — `CursorRunner.attach(...)` interface method

```ts
interface CursorRunner {
  run(input: CursorRunInput): Promise<CursorRunHandle>;
  // NEW
  attach(input: CursorRunAttachInput): Promise<CursorRunHandle>;
}

interface CursorRunAttachInput {
  readonly agentId: string;
  readonly runId: string;
  // Re-passed because SDK doesn't persist these across Agent.resume.
  readonly model: ModelSelection;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly agents?: Record<string, AgentDefinition>;
  readonly cloud?: CloudRunSpec; // required when the cursor_run is runtime: cloud
  readonly onEvent: (event: SDKMessage) => void | Promise<void>;
  readonly signal?: AbortSignal;
}
```

`attach` returns the same `CursorRunHandle` shape as `run`. The downstream caller can't distinguish between "fresh run" and "attached run" at the handle level — both yield events via `onEvent` and resolve `result` on terminal.

### F2 — `CloudCursorRunner.attach` implementation

1. `Agent.resume(input.agentId, { apiKey })` → `SDKAgent`.
2. `Agent.getRun(input.runId, { runtime: "cloud", agentId: input.agentId })` → `Run`.
3. From here the pipeline is identical to `run`'s post-`agent.send` path: stream events via `sdkRun.stream()`, terminal via `sdkRun.wait()`, finalize via `mapCloudRunResult`.
4. If `Agent.resume` throws because the agent is gone (expired, deleted, revoked) → throw `CursorAgentNotFoundError`. Caller (`ShipService`) maps this to `cursor_runs.status = 'failed'`, `workflow_run.status = 'failed'`, terminal write-back with an explanatory error message.

### F3 — Ship startup resume scan

On `ShipService` construction (or first `getWorkflowRun` / `listWorkflowRuns` call — see ED-3):

1. Query: `SELECT id FROM cursor_runs WHERE status IN ('running','pending') AND runtime = 'cloud'`.
2. For each row: hydrate `cursor_run` + parent `workflow_run` + parent `phase`. Reconstruct the `CursorRunAttachInput` from persisted state (model from `model_json`; cloud spec from `phases.input_json` for the implement phase; `mcpServers` and `agents` from re-renderable wiring config, not from the DB).
3. Call `cloudCursor.attach(...)`.
4. Wire the resulting handle back into the same finalize path used by fresh runs (`finalizeSuccess` / `finalizeFailure` in `service.ts`).
5. Resume failures (caught `CursorAgentNotFoundError` per F2) finalize the run as `failed` with `errorMessage: "cloud agent <id> no longer reachable on resume"`.

Idempotent — re-running the scan on an already-attached cursor_run is a no-op (see ED-4).

### F4 — `events.ndjson` continuity with a `resumed_at` marker

When `attach` succeeds, the cloud-runner emits exactly one synthetic event to `onEvent` **before** beginning to forward SDK stream events:

```json
{ "type": "ship.resumed", "ts": "<RFC3339>", "agentId": "bc-...", "runId": "run-..." }
```

The artifacts layer (`packages/core/src/artifacts/ndjson.ts`) appends this to the existing `events.ndjson` for the run — no new file, no truncation. Per the operator preference captured in [cursor-cloud-followups.md § B](../cursor-cloud-followups.md#b--agentresume-for-cloud-runs-across-ship-process-restart), continuous log over branched log.

`ship.resumed` is reserved as a **Ship-internal event type** — distinct from any `type` cursor SDK emits. (If the SDK ever introduces a `ship.*` type, this collides; we'd rename then. Treated as a stable internal contract from here forward.)

### F5 — Per-run event-pump for unattended cloud runs

A background async task runs per `status='running' AND runtime='cloud'` row. Its job: keep `events.ndjson` and `WorkflowRun.updatedAt` fresh even when no MCP client is currently consuming the stream.

Shape:

- One task per cursor_run; identified by `cursor_run.id`.
- Wakes on stream events (the same `onEvent` callback `run` uses).
- Heartbeat-bumps `workflow_runs.updated_at` every N seconds (TBD; sketch: 30s) so `list_workflow_runs` filter-by-stale works.
- On terminal, runs the normal `finalizeSuccess` / `finalizeFailure` path.
- Stops cleanly on `cancel`.

Started for: (a) every freshly-fired cloud run, (b) every resumed run from F3.

### F6 — `CursorAgentNotFoundError`

New error class in `packages/cursor-runner/src/errors.ts`. Carries `{ agentId, runId, runtime }`. Thrown when `Agent.resume` / `Agent.getRun` indicates the agent or run is gone.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Surface shape | **Add `attach` method to `CursorRunner`** | Redesign `CursorRunHandle` to be re-resolvable | Additive; doesn't break existing `run` callers; mirrors SDK's split between `Agent.create` and `Agent.resume`. |
| Local runner support | **Throw `LocalResumeNotSupportedError`** | Implement local attach via SDK's `Agent.resume` on local agents | Local agents die with the process — there's nothing to resume. SDK-level resume on local would require keeping the parent process alive, which the operator's process death already broke. Explicit error is honest. |
| Resume trigger | **`ShipService` constructor** (eager) | First `getWorkflowRun` call (lazy) | Eager means status is correct from t0 — `list_workflow_runs` doesn't need to special-case "this row says running but nobody's actually attached." Cost is a single SQL scan + N parallel resume calls at startup. Acceptable. |
| Events.ndjson shape | **Append with `ship.resumed` marker** | Branch `events.resumed.ndjson` | Operator preference (cursor-cloud-followups § B). Tooling that reads events.ndjson keeps working unchanged. |
| `attach` callers | **Internal-only: `ShipService.resumeOrphanedRuns`** | Expose `ship.attach` as a public MCP tool | No external use case yet — the use case is automatic recovery on restart, not "let me manually resume run X." MCP surface stays minimal. Revisit if a manual-resume need surfaces. |
| Pump cadence | **30s heartbeat (sketch)** | 5s aggressive / 5min lazy | Polls every 30s is cheap on SQLite, fresh-enough for human-readable status, and well under the cloud-run typical length (10-30min). Concrete number tuned in impl. |

## Engineering decisions

### ED-1 — `attach` is additive, not a redesign of `CursorRunHandle`

`CursorRunHandle.result` stays a one-shot promise. The promise is reconstructed inside `attach` — once `Agent.getRun` returns the live `Run`, the same handle-build pipeline runs. From the caller's perspective, an attached handle is indistinguishable from a fresh one (modulo the one synthetic `ship.resumed` event at the start of the stream).

### ED-2 — Local runner throws on `attach`

`LocalCursorRunner.attach` throws `LocalResumeNotSupportedError` unconditionally. SDK's resume works on local agents only as long as the parent process is alive, which is the exact scenario this phase is designed to recover from. Pretending to support it would invite misuse.

### ED-3 — Resume scan runs at `ShipService` construction, not lazily

Per the tradeoff table above. Concrete shape: `createShipService` returns a Promise (already does for migration setup) and includes the resume scan in the await chain. A pre-startup `cursor_runs` row count keeps the scan no-op when there's nothing to resume.

### ED-4 — `activeRuns` registry guards re-resume

`ShipService` already has the `activeRuns: Map<workflowRunId, { controller }>` registry. The resume scan checks-and-sets per row — if a workflowRunId is already in `activeRuns`, skip. Net: idempotent under concurrent `resumeOrphanedRuns` calls and safe if a manual `ship.ship` fires for the same workflowRunId mid-scan (the manual fire wins by virtue of being faster to insert into the registry).

### ED-5 — `mcpServers` and `agents` re-passed from wiring, not from DB

Per the SDK resume gotcha (`mcpServers` not persisted; same likely for inline `agents`), we re-build these from the same wiring layer used for fresh runs. Configuration is re-passable from `ServiceConfig`; no DB schema change for these inputs.

## Validation plan

(For the impl phase, not this design PR.)

- **Unit (`cloud-runner.attach`)** — fake SDK harness returns a resume-able agent; assert events stream + terminal write-back.
- **Unit (`ShipService.resumeOrphanedRuns`)** — fixture DB with N `running` cloud rows; assert N parallel `attach` calls; assert idempotent re-run.
- **Unit (`CursorAgentNotFoundError`)** — `Agent.resume` rejects → row finalizes as `failed` with the new error class as cause.
- **L2** — kill-mid-run scenario via `FakeCursorRunner.attach` + simulated process restart.
- **L3 (gated on `SHIP_LIVE` + `SHIP_CLOUD`)** — fire `ship.ship` against the sandbox, kill the ship-cli process before terminal, restart, assert the run completes with the same `workflowRunId` and a `ship.resumed` event in `events.ndjson`.
- **Negative** — explicit "local resume throws" unit test on `LocalCursorRunner.attach`.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cloud agent expired / disposed before resume | Resumes always fail post-expiry-window | Bounded; cursor's cloud agent retention is documented. Map to `CursorAgentNotFoundError`, finalize row as failed. Operator sees a clean failure with actionable error. |
| Two Ship processes both resume the same row | Double-write to events.ndjson; race on terminal write-back | Single-process Ship assumption (already implicit today). The `activeRuns` registry guards within a process; cross-process needs a SQLite advisory lock — explicitly out of scope for this phase. Document the constraint. |
| `agents` not persisted across `Agent.resume` | Resumed run's behavior differs from pre-resume (subagents missing) | Open question — if `agents` IS persisted (verify in spike), no action; if NOT, re-pass from wiring per ED-5. Either way the design admits both cases. |
| Heartbeat task leaks if `attach` fails before stream starts | Background tasks accumulate over startup-resume failures | Construct the pump task inside `attach`'s success path only; on failure throw before pump start. |
| `events.ndjson` concurrent write from the dying-then-resumed Ship | Two writers could trample lines | Resume only fires when no process is currently holding the row (resume scan happens at fresh startup; the dead process by definition has no writers). Single-process-at-a-time invariant carries. |
| `ship.resumed` event type collides with a future SDK type | Downstream consumers mis-classify | Reserved as a Ship-internal type; renamed if SDK ever ships a `ship.*` namespace. Treated as stable forward-compat from here. |

## Open questions (need spike before impl)

1. **Does `Agent.getRun(runId, { runtime: "cloud", agentId })` succeed for an in-flight run, and does the returned `Run`'s `stream()` work?** SDK docs imply yes but call this out for spike.
2. **Are inline `agents` (subagents) persisted across `Agent.resume`?** The resume gotcha calls out `model` and `mcpServers`; doesn't mention `agents`. Spike: resume a cloud agent created with `agents: { foo: {...} }`, dispatch the `task` tool to `foo`, observe.
3. **Does `sdkRun.cancel()` work on a resumed run?** Or does cancel require the original handle? Spike confirms the cross-process cancel story.
4. **Cloud agent retention window.** SDK docs imply cloud agents persist until `Agent.archive` / `Agent.delete`, but a TTL or auto-archive policy isn't documented. Worth confirming before relying on resume for multi-hour runs.

These questions are blockers for the impl phase but not for this design PR — the design admits multiple answers and notes which one each branch implies.

## Out of scope

- **Local runner resume.** Process death is fatal for local; SDK's local resume needs the parent alive. Explicit `LocalResumeNotSupportedError`.
- **Multi-process Ship coordination.** Cross-process SQLite advisory lock for "which Ship process owns this row" — single-process invariant is preserved; document it.
- **Manual / human-triggered resume MCP tool.** No `ship.attach` MCP surface this phase. If a manual-resume use case surfaces later, add it then.
- **Cross-SDK-version resume.** A resume across a Cursor SDK major bump may break (event types change, run shape changes). Documented as a known gap; deferred.
- **Persisting `mcpServers` in the DB.** Re-passing from wiring per ED-5; the DB doesn't grow a column for it.
- **Resume of failed / cancelled runs.** Scan filter is `status IN ('running','pending')` — terminal rows stay terminal.

## Implementation plan (when picked up)

Separate phase, not this PR. Sketch only, refined post-spike:

1. **Pre-impl spike** — answer Open Q 1-4. Findings doc at `pers/cursor-sdk-resume-spike/findings.md`. Don't start impl until each open question has a clear answer.
2. **Interface + errors** — `CursorRunner.attach`, `CursorRunAttachInput`, `CursorAgentNotFoundError`, `LocalResumeNotSupportedError`. Unit tests.
3. **CloudCursorRunner.attach** — `Agent.resume` + `Agent.getRun` + pipeline reuse. Unit tests with fake SDK.
4. **Event-pump** — per-run background task with heartbeat. Unit + integration tests.
5. **ShipService.resumeOrphanedRuns** — startup scan, idempotency via `activeRuns`. Unit + scenario tests.
6. **L3 scenario** — kill-mid-run + restart + terminal assertion.

Likely a 4-PR sequence (1 + 2 in one PR, 3, 4+5, 6) to stay inside the ideal band per PR.

## Cross-refs

- Predecessor: [phase 04](04-cursor-cloud-runner.md) — introduced `CloudCursorRunner`.
- Predecessor: [phase 06](06-cloud-fix-arc.md) — fixed cloud-runtime bugs needed for the L3 to be meaningful.
- Sibling phase 07: [07-open-pr-cloud-aware.md](07-open-pr-cloud-aware.md) — independent; resume + cloud-open-pr both touch `cursor_runs` but their changes are orthogonal.
- Backlog source: [cursor-cloud-followups.md § B](../cursor-cloud-followups.md#b--agentresume-for-cloud-runs-across-ship-process-restart).
- SDK: [docs/cursor-sdk-typescript.md § Resuming + listing + inspecting](../../cursor-sdk-typescript.md#resuming--listing--inspecting), § "Limitations to design around".
- Memory: `feedback_environment_agnostic.md` — substrate-agnostic posture preserved (`attach` lives on `CursorRunner`, not Ship-core).
- Memory: `feedback_design_doc_inline.md` — this is a design-only PR; light review expectations.

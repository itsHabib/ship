**Status**: draft
**Owner**: @michael
**Date**: 2026-07-12
**Related**: dossier task `event-pump-blinds-tick-liveness` (id: `tsk_01KWFV8KRDAM46V088DB5159PB`); adversarial pass on PR #166 (cap remote-liveness), finding "row 2's cited defense-in-depth is defeated"; #157 tick liveness; `docs/features/driver-freeze-gate/freeze-cap-remote-liveness.md` Non-goals.

# Event pump's local heartbeat blinds tick liveness for remote runs — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/cursor-runs/event-pump.ts`, `packages/core/src/service.ts` (both `onHandle` sites), driver `pollOneStream` → `noteWorkflowRunProgress`; possibly a store column (`last_event_at` or `pump_alive_at`) + migration | ~180 | 180 |
| Tests | silent-hung remote run trips inactivity give-up; active remote run stays live; `updated_at` consumers unaffected | ~180 | 90 |
| **Total** | | | **~270** |

Band: **amazing** (< 500). Single PR (grows to stretch if a migration is needed — acceptable, don't split).

## Goal

`startEventPump` bumps `workflow_runs.updated_at` from a bare local 30s `setInterval` (self-stopping only when the row is gone), started in `runToTerminal`'s `onHandle` for cloud/rooms and unconditionally in `runResumeAttach`'s `onHandle`. The driver tick's #157 liveness (`pollOneStream` → `noteWorkflowRunProgress(wfRun.updatedAt)`) treats `updated_at` changes as run progress — so while the local ship process lives, **every** remote run looks perpetually live, including a fully silent hung one. #157's inactivity give-up is structurally neutered for cloud runs; only the duration cap bounds them.

## Behavior / fix

Make the driver-visible progress signal reflect *remote* progress, not pump liveness. Candidate shapes from the task (pick one in the PR, state why):

- (a) pump heartbeats bump a separate `pump_alive_at` column; `updated_at` moves only on event-driven touches;
- (b) `noteWorkflowRunProgress` keys off a last-event timestamp (`events.ndjson` tail or a persisted `last_event_at`) instead of `updated_at`;
- (c) keep the `onEvent`-driven heartbeat; stop the timer-driven one from touching `updated_at`.

**Before moving anything**: audit which consumers rely on `updated_at` freshness — the `list_workflow_runs` stale filters were the pump's original purpose. The PR body must list the consumers checked and their disposition.

Note: the liveness-cancel PR (earlier in this manifest) makes `onEvent` activity the cancellation signal for the local cap; if it lands a persisted last-event timestamp, option (b) should reuse it rather than adding a second one.

## Acceptance

- A silent (no-events) remote run stops advancing the driver's progress signal and trips #157's inactivity give-up while the local pump is still alive.
- An actively-emitting remote run keeps registering progress.
- `updated_at`-freshness consumers (staleness filters) behave as before, or their migration is explicit in the PR.
- `make check` green.

## Non-goals

- The duration cap itself (PR #166 territory) — this changes only the progress signal the tick reads.

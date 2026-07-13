**Status**: draft
**Owner**: @michael
**Date**: 2026-07-12
**Related**: dossier task `liveness-aware-run-cancel` (id: `tsk_01KVPNYZ0CJ1G7BEG39WP36AP5`); duplicate `liveness-aware-run-cancellation` (tsk_01KW13XYWH131ARG92KQ2T39E2) cancelled — its monotonic-clock note is folded in below. Cross-ref: `cursor-error-status-root-cause-capture` (same evidence runs), `classify-failure.ts` `lastRunningToolCall`.

# Liveness-aware run cancel — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/cursor-runs/duration-cap.ts`, `packages/core/src/service.ts` (onEvent/heartbeat wiring), `@ship/workflow` `DEFAULT_WORKFLOW_POLICY` | ~150 | 150 |
| Tests | duration-cap tests adapted + new watchdog/suspension cases | ~200 | 100 |
| **Total** | | | **~250** |

Band: **amazing** (< 500).

## Goal

`runWithDurationCap` cancels on pure wall-clock elapsed via a single `setTimeout(windowMs)` armed at run start — it has no awareness of whether the agent is still working. Evidence: run `wf_01KVNKHBS61WJKZ9BVEQG6B5Y6` produced 566 real events, the laptop slept, and on wake the 30-min timer fired immediately (`elapsedMs:0, windowMs:1800000`) and cancelled a healthy run as `timeout-near-cap`. Operator framing: "if it can see it's still working it shouldn't matter what the timeout is."

## Behavior / fix

Replace the fixed deadline with an **inactivity watchdog**, keeping a generous absolute backstop:

1. **Primary signal = inactivity.** The run pipeline already routes every agent event through `onEvent` (ndjson write + heartbeat in `core/service.ts`). Reset a watchdog timer on each event; cancel only after `inactivityTimeoutMs` of *no events*. An actively-emitting agent never trips it, regardless of total wall-clock.
2. **Backstop = absolute ceiling.** Keep a hard wall-clock max (2–3× today's cap) so a runaway-but-chatty agent still terminates. Compute elapsed with a **monotonic clock** so suspension gaps don't count toward it.
3. **Policy field.** Add `inactivityTimeoutMs` to `DEFAULT_WORKFLOW_POLICY` in `@ship/workflow`; keep `maxRunDurationMs` as the backstop (rename only if cheap). Policy is config, not stored schema — confirm migration-free in the PR.
4. **Subsumes stuck-tool collapse.** A run stuck on a never-completing tool stops emitting → the watchdog fires; classification should reflect a stall (cross-ref `classify-failure.ts` `lastRunningToolCall` / `agent-collapse-on-running-tool`).
5. **Sleep robustness falls out.** "Time since last event" means suspension with no events re-evaluates on wake: agent resumes emitting → lives; dead → cancels after the window. No clock-jump false-cancel.

Applies to local runs (sleep/suspend) and to the local poller's cap over healthy cloud runs. Cursor behavior otherwise unchanged.

## Acceptance

- A run that keeps emitting events is never cancelled on wall-clock alone (below the backstop).
- A run that stops emitting for `inactivityTimeoutMs` is cancelled and classified as a stall.
- A simulated suspension (clock jump, no intervening events, then events resume) does NOT cancel the run.
- The backstop still bounds a pathological chatty-runaway run.
- Existing duration-cap tests adapted; `make check` green.

## Non-goals

- Root-cause capture for cursor error statuses (separate task `cursor-error-status-root-cause-capture`).
- Any change to the driver tick's remote-liveness signal (`event-pump-blinds-tick-liveness` — sequenced after this PR; both touch `service.ts` heartbeat wiring, coordinate at rebase).

# Phase 13 — L3 resume scenario test

Status: design ready
Owner: ship (cursor)
Date: 2026-05-23

> Third of 3 sequential PRs implementing the phase 08 design. **Depends on [phase 12](12-resume-orchestration.md) merged first** — exercises the whole resume stack (phase 11's `attach` primitive + phase 12's `resumeOrphanedRuns` + event-pump + `ship.resumed` event) against real cloud cursor. Dossier task: `tsk_01KSBJ3PHQNJ871MAHV5W3PW8M` (`phase-8c-l3-scenario`).

## Scope

**Weighted LOC budget — ~145, "amazing" band in 1 PR.**

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Test source | `e2e/scenarios/cloud-resume.e2e.test.ts` (new) | ~200 | 100 |
| Test helpers | `e2e/scenarios/cloud-e2e-helpers.ts` (minor additions for kill-process / restart-Ship plumbing) | ~50 | 25 |
| Production source | None (pure test) | 0 | 0 |
| **Total** | | | **~125-145** |

Files this phase touches:

- `e2e/scenarios/cloud-resume.e2e.test.ts` — **NEW**: end-to-end scenario.
- `e2e/scenarios/cloud-e2e-helpers.ts` — **MODIFY** if needed: add a kill-process + restart-Ship helper (or extract from existing helpers if the pattern's already there).

Out of scope:

- New production code (none required — phases 11 + 12 ship the stack; this PR just exercises it).
- Q4 retention window probe (longer-window observation; separate deferred sub-task).
- Multi-process Ship coordination scenario.

## Summary

The L3 scenario validates the full resume stack against real cloud cursor: fire a `ship.ship` cloud run, kill the ship-cli process before terminal, restart Ship, and assert the run completes with the same `workflowRunId` and a `ship.resumed` event in `events.ndjson`. This is the "does it actually work end-to-end against a real Cursor cloud agent" test — it catches integration bugs the L2 fake-SDK scenarios in phase 12 don't.

Gated on `SHIP_LIVE` + `SHIP_CLOUD` env vars so it skips cleanly in normal CI (matches other L3 cloud scenarios like `cloud-happy-path.e2e.test.ts`).

## Functional requirements

### Scenario shape

1. **Setup.** Set env: `SHIP_LIVE=1 SHIP_CLOUD=1 CURSOR_API_KEY=<...>`. Start a fresh Ship process pointed at a sandbox DB.
2. **Fire.** Call `ship.ship` with `runtime: "cloud"` against a task doc that contains a prompt the model can't shortcut — see "Critical constraint" below.
3. **Capture IDs.** Read back the `workflowRunId` + the persisted `agentId` / `runId` from the cursor_run row.
4. **Kill mid-flight.** Wait until the run is observably in `status: "running"` (poll `get_workflow_run` for ~5s); then `SIGTERM` the ship-cli process.
5. **Verify intermediate state.** The cursor_run row remains `status: "running"` in the DB; the cloud agent keeps running on Cursor's VM (no way to assert this directly, but the run shouldn't be cancelled).
6. **Restart.** Spawn a fresh ship-cli process against the same DB. Phase 12's `resumeOrphanedRuns` should auto-fire on construction and call `cloudCursor.attach(agentId, runId, ...)`.
7. **Assert resumption.** Within ~5s of restart, `events.ndjson` for the workflow run has a new `{ type: "ship.resumed", ... }` line. The cursor_run row stays `running` (no flip to failed).
8. **Assert terminal.** Wait for the resumed run to reach terminal. The workflow_run row finalizes as `succeeded` (or whatever the prompt's natural outcome is). Same `workflowRunId` throughout — no new row created on restart.
9. **Teardown.** Archive the cloud agent (`Agent.archive(agentId)`) so it doesn't linger.

### Critical constraint from the spike

**Use a prompt the model genuinely can't shortcut.** The phase 08 spike's `cancel-resumed` run completed in ~20s instead of the requested 60s because composer-2.5 collapsed "print one line per second for 60s" into a single output, losing the cancel race. For this L3 scenario, the prompt must force real time-in-VM:

- Explicit shell command: `sleep 60 && echo done` — the cloud VM actually waits.
- Real build step: `pnpm install` in a fresh checkout, or a long-running test suite.
- Recursive file walk over a large fixture.

Pick whichever's cheapest to set up that genuinely keeps the cloud agent busy for ≥30s. **DO NOT** use "print N lines slowly" — the spike confirmed composer-2.5 ignores the rate hint.

## Tradeoffs

(Inherited from [phase 08](08-agent-resume.md#tradeoffs). Slice-specific:)

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Gating | `SHIP_LIVE + SHIP_CLOUD` env vars | Always-on (in CI) | Costs real Cursor cloud time + money per run; gating matches other L3 scenarios. Skipped runs return `test.skip` for visibility, not silent pass. |
| Long-running prompt shape | Shell command (e.g. `sleep 60`) | "Print slowly" prompt | Spike proved the latter doesn't work — composer-2.5 collapses it. |
| Kill mechanism | `SIGTERM` on the ship-cli child process | `process.exit` from inside Ship | SIGTERM matches the real "operator hits Ctrl-C" or "process gets OOM-killed" path; in-process exit would skip the orchestration paths we want to exercise. |

## Engineering decisions

(Inherited from [phase 08](08-agent-resume.md#engineering-decisions). No new EDs introduced by this slice.)

## Validation plan

- **The scenario itself** is the validation — it's a black-box end-to-end test.
- **Local dry-run before fire.** Run the scenario locally with `SHIP_LIVE=1 SHIP_CLOUD=1` once before the PR merges to confirm it passes against real cloud. Capture the run's `workflowRunId` in the PR description as evidence.
- **Skipped path.** Run `pnpm test e2e/scenarios/cloud-resume.e2e.test.ts` WITHOUT the env vars to confirm it skips cleanly (no false failure).
- **`make check`** green (typecheck + lint + format-check + non-L3 tests).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cloud cost — every L3 run fires a real cloud agent | Burns ~$0.x per run; CI doesn't fire it (gated) | Gating + `SHIP_LIVE` opt-in. Document the cost expectation in the scenario header comment so future contributors know. |
| Flake from cloud-side latency | Resume not detectable within 5s of restart | Bump the assertion timeout (10-15s) if first runs show flake; record the actual observed time in the PR description. |
| The `sleep 60` prompt approach hits a Cursor model cap | Cloud agent refuses or shortcuts the prompt | If observed, switch to a real build/test workload. Document in PR description. |
| The kill-mid-flight + restart sequence has a TOCTOU bug | Test occasionally races and misses the `ship.resumed` event | Add a retry loop on the assertion side (poll events.ndjson for `ship.resumed` over ~10s); the orchestration in phase 12 is event-driven, so the race is bounded. |
| Cloud agent lingers if test crashes mid-scenario | Cursor-side cleanup debt | Wrap the scenario in a `finally` block that calls `Agent.archive(agentId)` unconditionally on exit. |

## Out of scope

- Q4 retention window probe — longer-window observation, separate sub-task.
- Multi-process Ship coordination scenario — single-process invariant per phase 08.
- L3 cancel-on-resumed-run scenario — phase 08 spike Q3 confirmed the endpoint is wired correctly; that variant can be added later if we ever want to assert mid-flight cancel-after-resume works (the spike's cancel-resumed bounced off `run_not_cancellable` because the run finished first).

## Implementation plan

Single PR. Step list = commit boundaries.

1. **Scenario file scaffolding.** New `e2e/scenarios/cloud-resume.e2e.test.ts` with the env gate + skeleton. Borrow the gating pattern from `cloud-happy-path.e2e.test.ts` or similar. **Validation:** file lints clean; skipped path runs (`make check` non-L3 paths green).

2. **Helpers.** Add a `killShipProcess` + `restartShipProcess` helper to `cloud-e2e-helpers.ts` (or whatever the e2e-helpers convention is). Keep them small and scenario-agnostic. **Validation:** scenario compiles against the helpers.

3. **Scenario impl.** Fill in the 9-step shape from F1 (above). Use the shell-command prompt that genuinely keeps the cloud agent busy. **Validation:** local dry-run with `SHIP_LIVE=1 SHIP_CLOUD=1` passes.

4. **Capture evidence + PR description.** Run the scenario once locally; paste the `workflowRunId` + observed durations into the PR description for reviewer context. Confirm cloud agent was archived after the run.

5. **`make check`.** Full repo green (the L3 scenario is gated so this should be unaffected).

## Cross-refs

- Overall design: [`08-agent-resume.md`](08-agent-resume.md) — Validation plan § L3.
- Spike findings: [`pers/cursor-sdk-resume-spike/findings.md`](../../../../cursor-sdk-resume-spike/findings.md) — Q3 (cancel endpoint) + the print-loop-shortcut anomaly that forced the constraint on the prompt shape.
- Predecessor: phase 12 (`12-resume-orchestration.md`) — ships the orchestration this scenario exercises.
- Sibling scenarios: `e2e/scenarios/cloud-happy-path.e2e.test.ts`, `cloud-cancel-during-creating.e2e.test.ts` — pattern reference for gating + cloud setup.
- Dossier task: `tsk_01KSBJ3PHQNJ871MAHV5W3PW8M` (`phase-8c-l3-scenario`).

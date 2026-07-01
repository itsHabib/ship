**Status**: draft
**Owner**: @michael
**Date**: 2026-07-01
**Related**: dossier task `cap-liveness-across-cloud-suspend` (id: `tsk_01KWF8YVA20WNYT4R608TKXBK0`), phase `driver-freeze-gate`. Promotes the "Considered alternative — deferred" from [freeze-duration-cap-suspend.md](freeze-duration-cap-suspend.md) (#165); Codex's P2 on #165 is the promotion trigger the deferral named.

# Duration cap: remote-liveness bound for already-started cloud runs — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/cursor-runs/duration-cap.ts` (~90), `packages/core/src/service.ts` (~50), `packages/agent-runner/src/runner.ts` + fakes (~30), `packages/cursor-runner/src/cloud-runner.ts` (~35), `packages/claude-runner/src/cloud-runner.ts` (~25) | ~230 | 230 |
| Tests | `duration-cap.test.ts`, runner unit tests, one L2 scenario | ~300 | 150 |
| **Total** | | | **~380** |

Band: **amazing** per the repo's PR sizing convention. Single PR — the decision procedure is one coupled state machine; splitting the signal plumbing from the decision would ship a fail-open intermediate state.

## Problem

#165 made the cap re-validate real elapsed against a **local monotonic clock** when the timer fires, re-arming on a misfire. Correct for the machine-clock-jump scenario it targeted — but for a **cloud run whose local driver process suspends**, the monotonic clock is the wrong ruler: on the platforms where suspend matters most, `CLOCK_MONOTONIC` pauses across the suspend, so on resume the misfire re-check sees almost no elapsed time and **re-grants the remaining window to a remote run that kept burning the whole time**. Repeated suspends repeat the re-grant (bounded only by `MAX_CAP_REARMS × window`).

Net: for a suspended driver, `maxRunDurationMs` degrades from "upper bound on the run's wall-clock duration" to "active-local-process-time budget" (Codex P2 on #165). The remote run's true age is a server-side fact; every local clock is only an estimate of it. For an already-started cloud run, the cap must be able to consult the run's **own** age.

## Fix — an age floor of same-clock signals; windows only ever shrink

Two rules carry the whole design:

1. **Age floor.** The cap tracks the best provable *lower bound* on the run's total age as a single run-scoped **high-water mark**: every signal reading folds into it (`floor = max(floor, signal)`) and it never decreases. Each signal is a same-clock pair, so each is a true lower bound under its stated assumptions; the ratchet means evidence once learned (e.g. a probe result) is never forgotten by a later decision point. Floor ≥ cap ⇒ expire (`timeout-near-cap`).
2. **Shrink-only windows.** New evidence can expire a granted window or re-arm a *smaller* one (`cap − floor`); nothing can ever extend a window past what was granted. The gate can degrade toward enforcement, never toward re-granting.

| Signal | Pair | Clock | Blind spot |
|---|---|---|---|
| `monoAge` | seed `elapsedMs` + (mono now − mono at arm) | local monotonic | pauses across suspend (#165 status quo) |
| `streamAge` | latest event ts − earliest known run ts | provider server | stream dies with the local connection; hung run emits nothing; on attach the stream-only anchor is the first *post-attach* event, so `streamAge` undercounts the pre-attach portion — conservative, but it makes the probe (whose `createdAt` is the true anchor) load-bearing on resume |
| `probeAge` | provider run record `updatedAt − createdAt` | provider server | `updatedAt` freezes on a hung run; needs a network round-trip |
| `wallAge` | local wall now − persisted `startedAt` | local wall ×2 | jumps with the wall clock — admitted **only** under the fail-closed rule below |

**Never cross clocks.** Every term is a same-source pair; a `server-createdAt vs local-now` delta is exactly the skew hazard this design exists to avoid, and appears nowhere. Also explicitly *not* a signal: `workflow_runs.updated_at` — the event pump bumps it from a local `setInterval`, so it measures local process liveness, not remote progress.

## Decision procedure

- **Arm and normal expiry: unchanged.** A timer whose full armed delay elapsed in real (monotonic) time, with the window consumed, expires exactly as today. No probe — `monoAge` is a true lower bound, so a mono-elapsed window means the run genuinely consumed its budget.
- **Misfire** (timer fired before its armed delay elapsed in real time — the suspend/clock-jump detector from #165):
  1. Fold max(`monoAge`, `streamAge`) into the sticky floor. If the floor (which already carries any earlier probe evidence) ≥ cap → expire now. No I/O on this path.
  2. Else re-arm for `cap − floor` (≤ the previous remaining — shrink-only), and fire **one bounded async probe** (`PROBE_TIMEOUT_MS`, ~10s):
     - Probe resolves with an age: fold into the floor; if now ≥ cap → expire immediately (clear the re-armed timer, resolve the synthetic, best-effort cancel). Reset the unreachable counter.
     - Probe unreachable (rejects / times out): increment a consecutive-failure counter. **Fail closed** when `unreachableCount ≥ CAP_PROBE_FAIL_CLOSED_AFTER` (3) **and** `wallAge ≥ cap`: expire. Rationale below.
     - A probe settling after the cap has already settled (expiry or a real result winning the race) is a no-op — the settled race wins; the late resolution folds nowhere.
- **Cloud attach** (resume): the call site passes `kind: "attach"`, and the probe is **id-addressed** (`agentId`/`runId` from the persisted row), so it does not wait for a handle: the cap fires the initial probe concurrently with `start()`. A probe age ≥ cap shrinks the remaining window — pre- or post-handle — to the existing grace floor (`MIN_RESUMED_CAP_WINDOW_MS`): an already-terminal run can still deliver its real result inside the grace; a still-running one gets the synthetic `timeout-near-cap` at its end; a still-stalled `start()` rejects `CursorRunStartTimedOutError` at the grace boundary exactly as the pre/post-handle split already prescribes. This closes the `startedAt`-missing / negative-delta hole where `resumeElapsedMs` returns 0 and today's code silently grants a full fresh window — including against a stalled `Agent.resume`/`Agent.getRun`, which previously would have held the full pre-handle window. The `kind` flag is required because the cap cannot distinguish "fresh dispatch" from "resume with a broken seed" by `elapsedMs === 0` alone.
- **One counter per run**: attach-time and misfire-time probes share the same consecutive-unreachable counter (it measures the provider's reachability for this run, not any one decision point); a success anywhere resets it. An unreachable attach probe alone never shrinks the window — the run keeps its seeded window and enforcement rides the normal expiry/misfire paths, with the accumulated counter feeding the fail-closed rule there.
- **No remote signals wired** (local runs, providers without support): the cap behaves exactly as #165 shipped it. Fresh-dispatch/local behavior must not regress.
- **`MAX_CAP_REARMS` backstop: unchanged.** Last line of defense against a pathological clock, sitting behind all of the above.

The synthetic terminal reports the **greater of the consumed cap budget and the age floor** — never less than the configured cap — so `classifyFailure` still lands on `timeout-near-cap` deterministically. (The floor alone is not enough: the `MAX_CAP_REARMS` forced-expiry path can fire while the floor is still below cap.)

## Failure semantics — the gate contract

| # | Scenario | Outcome |
|---|---|---|
| 1 | Suspend; remote run healthy and over cap on resume | Misfire → `streamAge`/probe ≥ cap → expire + cancel. The re-grant hole, closed. |
| 2 | Suspend; remote run hung (no events, `updatedAt` frozen) | Floor frozen below cap → re-arm per #165. Enforcement degrades to the status quo: cap fires within ≤ one window of *cumulative active* local time. Bounded residual, strictly no worse than today; the driver's #157 inactivity give-up also covers this run from above. Note the division of labor: a run that heartbeats without progressing evades #157 (looks alive) but **not** this cap — its server timestamps keep advancing, so the age floor grows to the cap regardless of progress. Only the fully silent hung run lands in this residual. |
| 3 | Timer misfire + wall jump forward, remote young (the F57 sandbox: both at once) | Sync floor small → re-arm; probe reachable and young → **no false cancel**. The wall estimate cannot fire here because the probe answered — this is the #165-regression guard. |
| 4 | Probe unreachable transiently | Counter increments; a later success resets it. No enforcement effect while the floor is below cap. |
| 5 | Probe unreachable ×3 consecutively **and** `wallAge ≥ cap` | **Fail closed** — expire. At this point every reachable estimate says over-cap and the authoritative source has been silent for three consecutive checks; holding the window open is the fail-open this gate exists to prevent. Accepted false-positive mode (API outage + forward wall jump + young run): the cancel is best-effort anyway and the stream re-triages as `timeout-near-cap` under the driver's normal retry policy. |
| 6 | Remote clock skewed vs local | No effect — no cross-clock term exists to skew. |
| 7 | Provider stamps garbage timestamps | Under-stamping under-counts → floor → residual #2 bound. Over-stamping (`updatedAt − createdAt` exceeding true age) could expire early — accepted: the pair comes from one provider record and is treated as authoritative for that provider's own run. |

## Layering

- **Runners are mechanism** — they expose raw signals, no decisions. Two optional members: a sync, I/O-free liveness snapshot on the handle, fed by the runner's own event stream (`{ createdAtMs?, lastEventAtMs? }` — server-stamped), and a bounded async **id-addressed** probe on the runner (`probeRun({ agentId, runId })`) returning the provider record's server-stamped `{ status?, createdAtMs?, updatedAtMs? }` — id-addressed so the attach path can consult it before a handle exists. Cursor cloud implements the probe from the agents REST surface (`V1Run.createdAt/updatedAt`; the SDK `Run` object exposes `createdAt` and live `status` — implementation may use whichever SDK/REST path yields the server pair). Claude cloud implements it over the sessions API if it exposes server timestamps cheaply, else returns `undefined` — a documented degrade, not an error. Local and rooms runners expose neither member.
- **Provider-origin events only.** The liveness snapshot is fed exclusively from provider-stamped events, upstream of any ship-synthesized event (e.g. the resume marker the cursor attach path injects carries a *local* timestamp). Letting a ship-synthesized timestamp into the snapshot would smuggle the cross-clock arithmetic back in through the side door.
- **The cap is policy** — floor composition, shrink-only invariant, the fail-closed counter, and the attach-time probe all live in `duration-cap.ts`. Exact member placement (on the handle vs injected via `DurationCapRunArgs`) is implementation latitude; the contract is: the sync signal does no I/O, the probe is bounded, and *no decision logic leaks into a runner*.
- **Both call sites threaded**: fresh dispatch (`runToTerminal`) wires the signals for cloud/rooms runtimes; resume (`runResumeAttach`) additionally passes `kind: "attach"`. Composition with #157 is by role, not by code: the driver tick's last-event-age owns *inactivity* give-up at the driver layer; the cap owns the *total-age* bound in core. Both read the same family of server-anchored signals and neither depends on the other's state.

## Acceptance

- For an already-started cloud run, a misfire re-arm consults the remote run's own age; age ≥ cap cancels instead of re-granting the window.
- Local-monotonic re-validation is preserved verbatim for fresh-dispatch/local runs (no #165 regression).
- A resume after the window has elapsed remotely gets at most the grace window, then cancels (`timeout-near-cap`) — including when the persisted seed is missing or insane, and including a stalled attach call that never produces a handle (the id-addressed probe bounds the pre-handle window too). It is never handed a fresh full window.
- `getRun`-style probe unreachable: no effect while transient; fail-closed per rule 5 once sustained with local evidence at/over cap.
- No cross-clock age term exists anywhere in the decision path.
- Both cap call sites threaded; `MAX_CAP_REARMS`, the grace floor, pre/post-handle expiry semantics, and `MAX_TIMER_DELAY_MS` segmentation all preserved.

## Test plan

`make check` green. Fake timers + injected monotonic clock (per #165's pattern) + scripted fake-runner signals:

- Misfire with `streamAge` ≥ cap → immediate expiry, no re-grant, cancel fired.
- Misfire with sync floor < cap and probe resolving ≥ cap → re-arm happens, then probe resolution expires early and clears the re-armed timer.
- F57-sandbox shape (misfire, wall jumped forward, probe reachable and young) → no false cancel; a later real result wins the race.
- Probe unreachable ×2 then success → counter resets, no expiry. Unreachable ×3 with `wallAge` ≥ cap → fail-closed expiry. Unreachable ×3 with `wallAge` < cap → no expiry.
- Sticky floor across misfires: a probe-raised floor survives to the next misfire's decision (no re-widening re-arm from recomputing only the sync signals).
- Attach with probe age ≥ cap → window shrinks to grace; a real terminal result inside the grace beats the synthetic; absent that, `timeout-near-cap`. Same shrink with the handle still absent (stalled attach) → `CursorRunStartTimedOutError` at the grace boundary.
- Attach probe unreachable → seeded window unchanged, counter incremented; a later misfire with `wallAge` ≥ cap completes the fail-closed rule.
- `MAX_CAP_REARMS` forced expiry with the floor still below cap → synthetic still reports ≥ the configured cap (`timeout-near-cap` preserved).
- Suspend + hung remote (all remote signals frozen) → active-time enforcement still fires within the #165 bound.
- No-signals runs: the entire existing duration-cap suite passes unchanged.
- Shrink-only property: across arbitrary misfire/probe interleavings, each armed delay ≤ the previous remaining window.

## Risks

- **Network I/O inside cap decisions.** Bounded per-call (`PROBE_TIMEOUT_MS`), fired only on misfire re-arms and attach — worst case `MAX_CAP_REARMS + 1` probes over a run's lifetime, zero on healthy clocks.
- **Hung remote + suspended local residual** (contract row 2): enforcement can lag by up to one window of active time. Documented; strictly better than today, and covered from above by #157.
- **Provider timestamp trust** (contract row 7): accepted for a provider's own run record.

## Non-goals

- Upward window correction from an over-estimated resume seed (rescuing a healthy young run grace-capped after a wall-jump restart). Deliberately excluded: it would break the shrink-only invariant that makes the gate reasoned-about; revisit only with a fail-open-proof design.
- Periodic (non-misfire) probing or a general remote-run poller — the driver tick already owns steady-state liveness.
- Driver-tick (#157) changes; `policy.maxRunDurationMs` semantics changes.

## Implementation plan

1. `agent-runner`: optional handle-level liveness snapshot + runner-level id-addressed `probeRun` + `AgentRunLiveness`/`AgentRunSnapshot` types; extend fakes with scriptable signals.
2. `cursor-runner` cloud: stream-fed liveness snapshot (provider-origin events only) + REST/SDK probe.
3. `claude-runner` cloud: sessions-API probe, or `undefined` degrade with a doc note.
4. `duration-cap.ts`: sticky floor, misfire decision, fail-closed counter, attach-time initial probe, `kind` arg, and a `wallAgeMs` supplier on `DurationCapRunArgs` (new input — the service injects it from the persisted `cursor_runs.startedAt`, which is stamped on the local wall clock at dispatch, vs `ctx.clock()` now).
5. `service.ts`: thread signals, `kind`, and the `wallAgeMs` supplier through `runToTerminal` and `runResumeAttach`.
6. Tests per plan. (The deferred-alternative pointer in `freeze-duration-cap-suspend.md` ships with this spec's own PR.)

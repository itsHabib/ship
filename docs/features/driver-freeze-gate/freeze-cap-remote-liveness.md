**Status**: draft
**Owner**: @michael
**Date**: 2026-07-01
**Related**: dossier task `cap-liveness-across-cloud-suspend` (id: `tsk_01KWF8YVA20WNYT4R608TKXBK0`), phase `driver-freeze-gate`. Promotes the "Considered alternative — deferred" from [freeze-duration-cap-suspend.md](freeze-duration-cap-suspend.md) (#165); Codex's P2 on #165 is the promotion trigger the deferral named. Revised after a review-panel cycle plus a 6-lens adversarial pass (23 attacks, 14 confirmed) — the confirmed breaks reshaped the decision model below.

# Duration cap: remote-liveness bound for already-started cloud runs — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/cursor-runs/duration-cap.ts` (~140), `packages/core/src/service.ts` (~60), `packages/store` (persist server `createdAtMs`, ~10), `packages/agent-runner/src/runner.ts` + fakes (~30), `packages/cursor-runner/src/cloud-runner.ts` (~40), `packages/claude-runner/src/cloud-runner.ts` (~25) | ~305 | 305 |
| Tests | `duration-cap.test.ts`, runner unit tests, one L2 scenario | ~380 | 190 |
| **Total** | | | **~495** |

Band: **amazing** per the repo's PR sizing convention. Single PR — the decision procedure is one coupled state machine; splitting the signal plumbing from the decision would ship a fail-open intermediate state.

## Problem

#165 made the cap re-validate real elapsed against a **local monotonic clock** when the timer fires, re-arming on a misfire. Correct for the environment it targeted (a sandbox whose timers fire early against the monotonic clock) — but for a **cloud run whose local driver suspends**, local clocks are the wrong ruler entirely, and the failure has two flavors:

- **Divergent-clock suspend** (VM pause/restore, the observed F57 sandbox): the timer fires *early* relative to the monotonic clock on resume. #165's misfire re-check catches the fire but then **re-grants the remaining window** to a remote run that kept burning the whole time.
- **Paused-clock suspend** (plain laptop/Linux suspend — the primary unattended-run target): Node's timer clock and `performance.now` share the same monotonic base, and both *pause together* across the suspend. The timer simply stretches — it fires late, having served its full armed delay in monotonic terms, so **no misfire ever occurs** and nothing local even notices the suspend happened.

In both flavors, `maxRunDurationMs` degrades from "upper bound on the run's wall-clock duration" to "active-local-process-time budget" (Codex P2 on #165). The remote run's true age is a server-side fact; every local clock is only an estimate of it. For an already-started cloud run, the cap must consult the run's **own** age — and must have a trigger that fires in *both* suspend flavors.

## Fix — a live age floor; the floor, not the timer, expires the run

Three rules carry the design:

1. **Live age floor.** The cap tracks a run-scoped lower bound on the run's total age that **ages between observations**: every signal sample folds in with its fold-time monotonic anchor, and `floor(now) = max over samples of (sampleAgeMs + trustedMonoSince(fold))`. Each term sums two same-clock durations (a server-pair age at sample time, plus a trusted local-monotonic duration since), so each term — and the max — is a true lower bound. The floor is a ratchet: it never decreases, and evidence once learned keeps counting (it pauses across a further suspend exactly as the mono clock does, staying a valid lower bound until the next fold re-covers the gap).
2. **Two expiry conditions — age proven, or budget spent.** The run expires when `floor(now) ≥ cap` (evidence of age, evaluated at every decision point: timer fire, stream-event fold, probe resolution, discontinuity hit), **or** when the granted window is exhausted in mono-corroborated time (a served fire with no window remaining — the budget spent). The window is the resume seed's only enforcement channel: it sizes the deadline (`max(cap − seed, grace)`) and that deadline never extends, so excluding the seed from the floor cannot re-grant a resumed run a fresh cap-sized budget. For a local run the floor is the trusted-mono term alone and the two conditions coincide with #165's behavior exactly.
3. **Windows only shrink — by construction.** At every fold the pending delay is re-derived: `armedDelay := min(remainingOfCurrentArm, max(0, cap − floor(now)))`; a result ≤ 0 expires immediately. No signal can extend a pending window, and the re-derivation can never exceed the current remainder (the earlier `cap − floor` phrasing could; the `min` is normative).

| Signal | Pair | Clock | Notes / blind spot |
|---|---|---|---|
| `monoAge` | trusted mono segments since arm (see fire classifier) | local monotonic | pauses across suspend; on remote-signal runs a *step-suspect* segment contributes **zero** (over-count-unsafe; local runs have no adjudicator and treat it as served) |
| `streamAge` | latest provider event ts − earliest known server anchor | provider server | folded **per event** (zero I/O); dies with the local connection; on attach the stream-only anchor undercounts pre-attach age unless the persisted server `createdAtMs` re-anchors it — the probe is load-bearing on resume |
| `probeAge` | provider record `updatedAt − createdAt` | provider server | freezes on a hung run; needs a bounded network round-trip |
| `wallAge` | local wall now − persisted `startedAt` (fallback: the run row's creation wall time when `startedAt` is missing/insane) | local wall ×2 | jumps with the wall clock — admitted **only** in the rule-5 fail-closed conjunction, never into the floor |

**Never cross clocks.** No age term ever subtracts instants read from two different clocks; sums of same-clock *durations* are permitted (that is what aging a sample is). The resume **seed never enters the floor** — its only role is sizing the initial window (existing `capWindowMs` semantics); on resume the floor starts at 0 and grows only from server-anchored folds and trusted mono. Also explicitly *not* a signal: `workflow_runs.updated_at` — the event pump bumps it from a local `setInterval`, so it measures local process liveness, not remote progress.

## Decision points

- **Timer fire — classified two-sided** against its armed delay (slack ~60s), because a fire's timing is evidence about the clocks themselves:
  - *Served* (`monoΔ ≈ armedDelay`): a mono-corroborated segment. Fold it into `monoAge` (plus any fresh sync signals). Expire when floor ≥ cap **or** the granted window has no remainder (the seed-sized deadline maturing — rule 2's second condition). Floor < cap with window remaining — a `MAX_TIMER_DELAY_MS` clamped segment of a longer window — re-arms for `min(windowRemaining, cap − floor)`: the healthy continuation from #165, spending no re-arm budget and firing no probe. Local runs always take this path unchanged.
  - *Early* (`monoΔ < armedDelay`): the #165 misfire (divergent-clock flavor). Fold the (trusted) mono delta and `streamAge`; floor ≥ cap → expire; else re-arm per rule 3, fire **one bounded probe** (`PROBE_TIMEOUT_MS`, ~10s), spend the re-arm budget.
  - *Late* (`monoΔ > armedDelay + slack`): a **step-suspect** fire — the monotonic clock itself jumped forward (or the event loop stalled). The suspect segment's mono delta is over-count-unsafe and provisionally contributes zero to the floor. For a remote-signal run: fold `streamAge`; floor ≥ cap → expire; else re-arm + probe — the probe adjudicates, so a forward mono step cannot false-cancel a young cloud run unprobed. **The adjudication must then land somewhere**: if the probe settles without an authoritative age (unreachable, or a degrade-provider resolve without usable fields — and immediately at the fire when no probe member exists at all), the suspect segment is retroactively **charged as served** (its armed delay folds into `monoAge`) — an unadjudicated provider gets local-run semantics, else repeated event-loop stalls would defer the cap indefinitely with nothing advancing. The charge is a ratchet fold and is not undone by a later young answer (documented: flaky-probe providers degrade to the #165 active-time budget). For a **local** run there is no adjudicator: charge the segment as served and follow the served branch's full logic — expire on floor ≥ cap or window exhaustion, else the clamped-segment continuation re-arms (a stalled mid-window segment of a long cap must not expire the whole run early). Status quo, documented residual: a genuine event-loop stall and a mono step are locally indistinguishable, and mono is the only truth available.
- **Wake / discontinuity detector** (remote-signal runs only): paired `(wall, mono)` readings sampled on a coarse local cadence (the event-pump interval). When `wallΔ − monoΔ` across one interval exceeds a threshold (~60s), the local clocks paused together — the paused-clock suspend flavor, which produces **no** early fire. Run the early-fire steps: fold sync signals, expire if floor ≥ cap, else re-arm + one bounded probe. The detector compares two same-clock *deltas* and yields a **trigger, never an age term** — the never-cross-clocks rule is untouched. Zero remote I/O when nothing discontinuous happened.
- **Stream-event fold** (remote-signal runs): every provider-stamped event folds `streamAge` and re-derives the window per rule 3 — no I/O. After a paused-clock suspend, the reconnected stream's first event alone can expire an over-cap run before any detector hit or probe.
- **Probe resolution** (attach, misfire, or detector-triggered — one shared machinery):
  - Resolves with an age: fold; re-derive the window per rule 3 (expire / shrink / no-op). A server-anchored age **< cap additionally (a)** resets the consecutive-unreachable counter and **(b)** resets the misfire re-arm budget — the backstop's meaning becomes "consecutive re-arms since the last server-anchored proof of youth", so a long-cap run spanning many suspends is not force-expired while every probe confirms it young.
  - Resolves without usable fields (provider degrade): neither counter moves; the window stands — except when the probe was adjudicating a step-suspect segment, in which case the charge rule above applies (the segment folds as served).
  - Unreachable (rejects / times out): shared per-run counter++. **Fail closed** at `unreachableCount ≥ CAP_PROBE_FAIL_CLOSED_AFTER` (3) **and** `wallAge ≥ cap` — at that point every local estimate says over-cap and the authoritative source has been silent for three consecutive checks. `wallAge` falls back to the run row's creation wall time when `startedAt` is broken, so a broken seed cannot structurally disarm the rule.
  - A probe settling after the cap has settled (expiry or a real result winning) is a no-op — the settled race wins.
- **Cloud attach** (`kind: "attach"`; the id-addressed probe — `probeRun({ agentId, runId })` — fires concurrently with `start()`, no handle needed):
  - *Sane positive seed*: window = `max(cap − seed, grace)` — existing semantics, unchanged. An unreachable probe here never shrinks the window (the seed already encodes real elapsed; transient blips must not kill healthy resumes).
  - *Broken seed* (`startedAt` missing / non-positive delta): first fall back to a **durable anchor** — the run row's creation wall time (stamped at dispatch, same trust level as `startedAt`, already the rule-5 fallback) — which turns most broken seeds into sane seeds whose deadline holds across restart loops (`seed = now − rowCreatedAt` keeps growing; no per-restart re-grant). Only when no durable anchor exists at all (elapsed truly **unknown**, not 0) does the window arm at the **grace floor** — fail-toward-grace, capping the blast radius of every downstream signal failure — with the attach probe **retrying** on a bounded schedule (~every 30–60s, up to the fail-closed budget, sharing the unreachable counter). The first age-bearing answer folds and re-derives per rule 3 — from a grace window that is a no-op (no upward correction; a young run with a destroyed seed dies at grace: documented residual, same shape as today's wall-jump-inflated seed). A probe-less provider (degrade) with no anchor gets the same grace-bounded window; the anchor fallback is what keeps restart loops from compounding grants.
  - *Server-anchored seeds*: dispatch persists the provider's server-stamped `createdAtMs` on the run row when the dispatch/liveness surface exposes it; later attaches derive the seed and the `streamAge` anchor from it (a server×server pair), making broken local seeds rare rather than load-bearing.
- **`MAX_CAP_REARMS` backstop**: consecutive-since-proof semantics per above; still the mechanical last line (with rule 5) against a pathological clock that never lets the floor reach the window.

The synthetic terminal reports the **greater of the consumed cap budget and the age floor** — never less than the configured cap — so `classifyFailure` still lands on `timeout-near-cap` deterministically (including the backstop path, where the floor may still be below cap). Pre-handle expiry keeps rejecting `CursorRunStartTimedOutError` per the existing pre/post-handle split (a stalled attach with a broken seed now hits it at the grace boundary instead of holding a full window).

## Failure semantics — the gate contract

| # | Scenario | Outcome |
|---|---|---|
| 1a | Paused-clock suspend (laptop/Linux); remote healthy and over cap | No early fire exists — the **detector** (or the first reconnected stream event, whichever lands first) folds server-anchored age ≥ cap → expire + cancel. The re-grant hole, closed for the flavor the primary platforms actually produce. |
| 1b | Divergent-clock suspend (VM restore, F57 sandbox); remote over cap | Early fire → misfire path → `streamAge`/probe ≥ cap → expire + cancel. |
| 2 | Suspend; remote run hung (no events, `updatedAt` frozen), probe reachable-but-frozen | Floor frozen below cap → shrink-only re-arms; enforcement rests **solely on the cap's trusted-active-time accounting**: it fires within ≤ one window of cumulative awake time. Honest note: the driver's #157 give-up does *not* bound this run — its liveness signal is the pump-bumped local `updated_at`, so while the local process lives every run looks live to it, and its give-up ends the tick without cancelling. (Fixing that adjacent gap is its own task.) A run that heartbeats without progressing, by contrast, *is* caught here: its server timestamps advance, so the floor reaches the cap regardless of progress. |
| 3a | Early fire + forward wall jump, remote young, probe reachable (F57 shape) | Sync floor small → re-arm; probe answers young → **no false cancel**. The wall estimate cannot fire — rule 5 needs the probe dark. |
| 3b | **Forward monotonic step** (late fire), remote young | Step-suspect fire: the suspect mono segment provisionally folds zero; the probe adjudicates → young run survives. Probe unable to adjudicate (unreachable / degrade / absent) → the segment is charged as served: the provider gets local-run semantics, so repeated stalls cannot defer the cap. Local runs: no adjudicator — expires (documented residual, which the charge rule extends to unadjudicated providers). |
| 4 | Probe unreachable transiently | Counter increments; any later success resets it. No enforcement effect while the floor is below cap. |
| 5 | Probe unreachable ×3 consecutively **and** `wallAge ≥ cap` | **Fail closed** — expire. Accepted false-positive mode (API outage + forward wall jump + young run): cancel is best-effort and the stream re-triages as `timeout-near-cap` under the driver's normal retry policy. |
| 6 | Remote clock skewed vs local | No effect — no age term subtracts instants across clocks; the detector's wallΔ−monoΔ comparison is delta-vs-delta, not an age. |
| 7 | Provider stamps garbage timestamps | Under-stamping under-counts → floor → residual row-2 bound. Over-stamping could expire early — accepted: the pair comes from one provider record, treated as authoritative for that provider's own run. |
| 8 | Broken seed **and** probe dark/absent at attach | The row-creation anchor turns most of these into sane seeds with a durable, restart-stable deadline. With no anchor at all: grace-bounded window per attach (fail-toward-grace) — never a full fresh window. Recovery of a young run's real result rides the probe retries inside the grace, then the driver's retry policy. |

## Layering

- **Runners are mechanism** — raw signals, no decisions. Two optional members: a sync, I/O-free liveness snapshot on the handle fed by the runner's own event stream (`{ createdAtMs?, lastEventAtMs? }`, server-stamped), and a bounded async **id-addressed** `probeRun({ agentId, runId })` on the runner returning the provider record's server-stamped `{ status?, createdAtMs?, updatedAtMs? }` — id-addressed so attach consults it before any handle exists. Cursor cloud: agents REST surface (`V1Run.createdAt/updatedAt`; the SDK `Run` exposes `createdAt` + live `status` — any SDK/REST path yielding the server pair is fine). Claude cloud: sessions API if it exposes server timestamps cheaply, else `undefined` — a documented degrade. Local and rooms runners expose neither member.
- **Provider-origin events only.** The liveness snapshot and the per-event fold consume only provider-stamped events, upstream of ship-synthesized events (the cursor attach path's resume marker carries a *local* timestamp) — otherwise the cross-clock arithmetic returns through the side door.
- **The cap is policy** — the floor, fire classifier, detector, fail-closed counter, seed rules, and re-derivation all live in `duration-cap.ts`. The detector's cadence hook and the `wallAgeMs`/`createdAtMs` suppliers are injected by `service.ts`; member placement is implementation latitude, but the sync members do no I/O, the probe is bounded, and no decision logic leaks into a runner.
- **Composition with #157 is by role**: the cap owns run-age enforcement from server-anchored signals; the driver tick owns tick-time inactivity give-up — which today reads the pump-bumped local `updated_at`, i.e. local process liveness, *not* a server signal. They share no state. (The pump blinding #157's staleness signal for live processes is a pre-existing adjacent gap, tracked separately.)
- **Both call sites threaded**: fresh dispatch (`runToTerminal`) wires the signals for cloud/rooms; resume (`runResumeAttach`) additionally passes `kind: "attach"` and the persisted seed/`createdAtMs`.

## Acceptance

- For an already-started cloud run, **both suspend flavors** (paused-clock and divergent-clock) lead to a server-anchored age consultation; age ≥ cap cancels instead of re-granting. Neither flavor's enforcement depends on a timer misfiring.
- The floor is live (samples age via trusted mono), monotone, and never contains a cross-clock instant subtraction or the resume seed.
- Every fold re-derives the pending window as `min(remaining, max(0, cap − floor))`; no code path extends a pending window.
- Local-run behavior is bit-for-bit #165: served fires expire at window maturity; no probes, no detector, no stream folds.
- A resume never receives a full fresh window without evidence: sane seed → `max(cap − seed, grace)`; broken seed → grace + probe retries. The seeded window is a **non-extending deadline** — it expires the run at maturity even while the floor is below cap (rule 2's second condition), so keeping the seed out of the floor cannot re-grant a fresh budget. Both bounded; `CursorRunStartTimedOutError` semantics preserved pre-handle.
- Probe unreachability: transient → counted, no effect; sustained + `wallAge ≥ cap` (with row-creation fallback) → fail closed.
- `MAX_CAP_REARMS` (consecutive-since-proof), the grace floor, `MAX_TIMER_DELAY_MS` segmentation, and synthetic-terminal `timeout-near-cap` determinism all preserved.

## Test plan

`make check` green. Fake timers + injected monotonic clock + scripted fake-runner signals (fakes expose scriptable liveness/probe and a manual detector tick):

- Paused-clock suspend: no early fire; detector hit folds probe/stream age ≥ cap → expiry + cancel. Same scenario with the stream reconnecting first → the event fold alone expires it. Detector false positive: a hit on a young run → probe confirms young → window shrinks per rule 3, run survives.
- Divergent-clock suspend (early fire): sync floor ≥ cap → immediate expiry; sync floor < cap with probe ≥ cap → expiry on probe resolution, re-armed timer cleared.
- Step-suspect (late) fire on a cloud run: suspect mono folds zero; young probe → survives; over-cap stream age → expires. Probe unreachable / degrade-resolve / absent → the segment is charged as served, and repeated stalls exhaust the window (no indefinite deferral). Same late fire on a local run → expires (status quo).
- Seeded deadline: a sane-seed resume with a quiet floor (no server folds) expires at `max(cap − seed, grace)` maturity — never re-arms toward a fresh cap-sized budget.
- Aged floor: a probe answer folded at T keeps counting through trusted segments; a second suspend pauses it; the next fold re-covers. Floor never decreases (property).
- Re-derivation: any fold that raises the floor shrinks the pending delay to `min(remaining, cap − floor)`; armed delay never exceeds the previous remainder across arbitrary fold/fire interleavings (property).
- Rearm budget: probe-confirmed-young resets it; a probe-dark suspend series exhausts it → forced expiry with the synthetic reporting ≥ cap.
- Unreachable counter: ×2 then success resets; ×3 + `wallAge ≥ cap` → fail-closed; ×3 + `wallAge < cap` → no expiry; broken `startedAt` → row-creation fallback feeds rule 5.
- Attach: sane seed unchanged (grace floor arithmetic per existing tests); broken `startedAt` falls back to the row-creation anchor (deadline stable across a restart loop — the second attach's window shrinks, never resets); no anchor at all → grace + probe retry schedule; probe-less provider + no anchor → grace-bounded, `CursorRunStartTimedOutError` on a stalled start at the grace boundary.
- Local late fire mid-window on a segmented long cap → clamped continuation (no premature expiry); at window exhaustion → expires.
- F57 sandbox shape (early fire + wall jump + reachable young probe) → no false cancel; a later real result wins the race.
- No-signals runs: the entire existing duration-cap suite passes unchanged.

## Risks

- **Probe/network budget**: bounded per call (`PROBE_TIMEOUT_MS`), fired only on early/step-suspect fires, detector hits, and the attach schedule — worst case `MAX_CAP_REARMS + attach retries + detector hits`, zero on healthy clocks with sane seeds.
- **Detector threshold tuning**: too tight → spurious folds+probes on NTP slews (cheap, shrink-only — safe); too loose → short suspends undetected (covered by the stream fold and the next fire). Not a correctness cliff in either direction.
- **False-cancel residuals, enumerated**: local-run forward mono step (3b); young run with a destroyed seed dying at grace (8); rule-5's accepted conjunction (5). Each bounded and recoverable by the driver's retry policy.
- **Hung remote + probe-dark residual** (row 2): enforcement lags up to one window of awake time — the bound rests on the cap alone.

## Non-goals

- **No upward correction, ever**: no signal, including an authoritative young probe, extends a pending window (broken-seed grace included). The shrink-only invariant is what makes the gate reasoned-about; rescuing seeds is done by *persisting better anchors* (server `createdAtMs`), not by widening windows.
- **No steady-state remote polling**: probes fire only on discontinuity evidence (early/step-suspect fires, detector hits) and the attach schedule. The detector itself is two local clock reads on an existing cadence, not remote I/O.
- Driver-tick (#157) changes — including fixing the event pump blinding its staleness signal (adjacent pre-existing gap; tracked as its own task).
- `policy.maxRunDurationMs` semantics changes.

## Implementation plan

1. `agent-runner`: optional handle-level liveness snapshot + runner-level id-addressed `probeRun` + `AgentRunLiveness`/`AgentRunSnapshot` types; fakes gain scriptable signals and a manual detector tick.
2. `store`: persist server `createdAtMs` on the cursor-run row when the dispatch surface exposes it.
3. `cursor-runner` cloud: stream-fed liveness snapshot (provider-origin events only) + REST/SDK probe.
4. `claude-runner` cloud: sessions-API probe, or `undefined` degrade with a doc note.
5. `duration-cap.ts`: live floor (aged samples), two-sided fire classifier, discontinuity detector hook, per-event fold entry point, probe machinery (shared counter, budget reset, retry schedule on broken-seed attach), rule-3 re-derivation, `kind` arg, `wallAgeMs` + `rowCreatedAtWallMs` suppliers on `DurationCapRunArgs` (service injects from the persisted row vs `ctx.clock()`).
6. `service.ts`: thread signals, `kind`, seeds, and the detector cadence through `runToTerminal` and `runResumeAttach`; wire the per-event fold into the existing `onEvent` taps — the provider-origin-only filter is enforced at this wire-up point (ship-synthesized events never reach the fold), not inside `duration-cap.ts`.
7. Tests per plan. (The deferred-alternative pointer in `freeze-duration-cap-suspend.md` ships with this spec's own PR.)

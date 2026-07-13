**Status**: todo (needs source-confirmation before scope is locked — see step 1)
**Owner**: @michael
**Date**: 2026-07-05
**Related**: dossier task `dispatch-failure-circuit-breaker` (project `ship`). **Depends on / pairs with** [observability/phases/cloud-sdk-cause-persistence.md](../observability/phases/cloud-sdk-cause-persistence.md) — the breaker's escalation is far more useful once the persisted cause names *why* the dispatch died. **Motivating incident:** `freeze-scoped-merge-grant` dispatched ~14× (2026-07-02 14:27 → 07-03 05:50), every run `sdk-throw; agent.send failed after Agent.create`, ~hourly, each failing in ~3.5s. Nothing detected that the dispatch was deterministically doomed; it just re-fired until the driving session ended. Two `claimed` tasks never landed and the loop was invisible on every surface except a manual `list_workflow_runs` scan.

# Circuit-breaker: stop re-dispatching a deterministically-failing doc

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | **TBD by step 1.** If driver-owned: `packages/driver/src/dispatch.ts`-equivalent path in `engine.ts` + attempt/failure counting on `StreamAttempt` (`@ship/store`), park + `escalation.ts` new class. If caller-owned: the `/work-driver` skill loop's per-stream failure-abort (no repo code) | ~150 | 150 |
| Tests | consecutive-failure count → park; distinct-failure does not trip; reset on success; escalation row written once | ~180 | 90 |
| **Total** | | | **~240** |

Band: **amazing** (< 500). Almost certainly a single PR; the surface is one counter + one park/escalation branch.

## Functional

The principle: **N consecutive failures of the same dispatch surface once, then stop — not N times, silently.** Concretely, after a small threshold (default **3**) of consecutive failed dispatches of the same stream/doc with no intervening success, halt further auto-dispatch of that unit and raise a single escalation (reusing the shipped tier/notify machinery) instead of re-firing on the next tick/loop.

The exact home depends on step 1:

1. **Confirm the re-fire source (blocking).** The incident rows have **no `driverRunId`** and are single-phase top-level `ship.ship` cloud runs — strong evidence they did **not** flow through the driver engine, i.e. an external `/work-driver` (or `/loop`) re-invoked dispatch hourly. Confirm by inspecting the freeze-gate `driver.md` manifest + whether any `driver_run` row references these `wf` ids. Outcome decides scope:
   - **Driver-owned** → the engine re-dispatched (or would have). Add the breaker in the dispatch path.
   - **Caller-owned** (likely) → the `/work-driver` skill loop had no failure-abort. The breaker is a loop guard in the skill; the repo change is optional (a reusable "consecutive-failure" helper the skill can call), and the *primary* fix is the skill.
2. **Count consecutive dispatch failures per unit.** Driver path: extend `StreamAttempt` accounting to track consecutive `sdk-throw`/failed dispatches with no intervening non-failed attempt; a success or a `driver decide` resets it. Caller path: the loop tracks per-doc failure count across iterations.
3. **Trip at the threshold → park + escalate once.** Reuse `escalation.ts`: a new class (e.g. `dispatch-failing`) at `queue` tier, written **once** when the counter crosses the threshold (idempotent, mirroring `EscalationOpenRowExistsError` handling). The parked unit is excluded from `couldDispatchThisTick` until a human `driver decide` (retry/skip/abort) clears it.
4. **Default threshold 3, configurable.** Mirror the review-cycle cap convention; expose via the same config seam as `escalation.tiers`.

## Tradeoffs

- **Consecutive vs windowed count.** Consecutive-with-reset-on-success is simpler and matches the "deterministically doomed" signal (14/14 identical). A sliding window catches flapping but adds state; **default consecutive**, revisit only if flapping shows up.
- **Threshold value.** Too low (1–2) parks on a transient 429/5xx blip; too high wastes dispatches. **3** matches the operator's 3-cycle review cap and gives one transient-tolerant retry before parking.
- **Where it lives.** A repo-side breaker (driver) protects *every* caller including future Fable runs and any cron; a skill-side loop guard only protects `/work-driver`. If step 1 says caller-owned, still consider landing the reusable counter in the engine so the guarantee isn't skill-specific — decide in step 1.

## EDs

- Step-1 finding (driver vs caller) — this doc cannot lock its own scope without it. Everything downstream is conditional on that outcome.
- Pairs with `cloud-sdk-cause-persistence`: a park escalation that says "3× sdk-throw" is weak; "3× HTTP 400 invalid_request_error" is actionable. Not a hard dependency, but land that first if sequencing.

## Validation

- Unit: 3 consecutive same-unit dispatch failures → parked + exactly one escalation row; a 4th tick does not re-dispatch.
- Unit: 2 failures then a success → counter resets, no park.
- Unit: distinct units failing once each do **not** trip (per-unit, not global).
- Unit: escalation write is idempotent across ticks (no duplicate open rows).
- Unit (caller path, if chosen): the loop aborts the doc after the threshold and reports it.
- `make check` incl. coverage gate green.

## Risks

- **Parking a merely-slow-to-succeed unit** on transient errors — mitigated by threshold 3 + reset-on-success + `driver decide` retry to un-park.
- **Scope drift from an unconfirmed source** — mitigated by making step 1 blocking; do not write code before the source is confirmed.
- **Two breakers** (driver + skill) double-counting — pick one home in step 1; if both, the skill defers to the engine's signal.

## Out of scope

- Auto-retry with backoff — this task *stops* retrying, it doesn't retry smarter. A backoff policy is a separate call.
- Diagnosing *why* a given doc fails to dispatch (that's `cloud-sdk-cause-persistence`) — the breaker only counts and parks.
- The `freeze-scoped-merge-grant` doc's own content fix (it's over the PR-size split threshold and should be split regardless — a separate chore).
- Liveness-based *cancellation* of a running dispatch (`liveness-aware-run-cancellation`, `event-pump-blinds-tick-liveness`) — adjacent subsystem, different signal.

## Implementation plan

1. **Confirm source** (freeze-gate `driver.md` + `driver_run` rows vs the incident `wf` ids). Lock scope. No code before this.
2. Add per-unit consecutive-failure counting (driver `StreamAttempt` accounting, or the skill loop's per-doc counter) with reset-on-success/decide.
3. Trip → park + one idempotent `dispatch-failing` escalation via the existing tier/notify machinery; exclude parked units from dispatch until `driver decide`.
4. Config threshold (default 3) on the `escalation` config seam (+ tests).

Single PR (~240 weighted) once step 1 locks the home.

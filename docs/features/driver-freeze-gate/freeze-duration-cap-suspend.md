**Status**: draft
**Owner**: @michael
**Date**: 2026-06-30
**Related**: dossier task `freeze-duration-cap-suspend-resilient` (id: `tsk_01KW4ZWBPZTQX8PYK3XQZ0XTBJ`), phase `driver-freeze-gate`. F57's second head — sibling of #157 (`freeze-liveness-aware-cancel`).

# Duration-cap suspend / clock-jump resilience — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/cursor-runs/duration-cap.ts` | ~55 | 55 |
| Tests | `packages/core/src/cursor-runs/duration-cap.test.ts` | ~90 | 45 |
| **Total** | | | **~100** |

Band: **amazing** per the repo's PR sizing convention. No `service.ts` wiring change — the monotonic clock defaults to `performance.now`; only tests inject it.

## Problem

`runWithDurationCap` enforces `policy.maxRunDurationMs` by arming a bare `setTimeout(expire, windowMs)` (windowMs = 30 min for a fresh dispatch). The timer is event-loop based and the expiry callback trusts the fire **unconditionally** — it synthesizes a `failed` terminal (or rejects `CursorRunStartTimedOutError` pre-handle) the instant it fires. When the host process is **suspended/resumed or the wall clock jumps forward**, the overdue timer fires immediately on resume with **no real run time elapsed** → a synthetic `failed` whose `durationMs >= maxRunDurationMs` lands `classifyFailure` on `timeout-near-cap`.

Observed live in the `driver-freeze-gate` cloud dogfood (2026-06-27, `drv_01KW3RQ69V6DQCMHWXGDHA60B4`): two consecutive fresh batch-2 dispatches both insta-failed with `elapsedMs:0, windowMs:1800000, "policy.maxRunDurationMs exceeded"`, their logs stamped ~2.28h apart despite being issued seconds apart in real time — the sandbox wall clock jumped between turns. Cloud dispatch is deterministically broken on a machine whose clock isn't monotonic-stable.

This is **F57's second head**. PR #157 made the *driver tick* give-up liveness-aware (monotonic last-event-age) and its spec flagged: "confirm whether the F57 sleep-cancel also fires in the cursor runner's own timeout." It does — here, in the core cap.

## Behavior / fix

Re-validate against a **monotonic** measurement before declaring the cap exceeded, so the cap only fires on genuine elapsed run time — never on a timer that misfired after a discontinuity.

- **Measure with a monotonic clock.** Add `monotonicClock?: () => number` to `DurationCapRunArgs`, defaulting to `performance.now`. Record `startedMono = monotonicClock()` at arm time. A monotonic clock is immune to wall-clock (NTP) jumps and, on the platforms where the fix matters most (Linux, where `CLOCK_MONOTONIC` pauses across suspend), does not advance during a suspend. This mirrors #157's `monotonicClock: () => number` (default `performance.now.bind(performance)`).
- **Re-check real elapsed on fire; re-arm on misfire.** When the timer fires, compute `realElapsed = monotonicClock() - startedMono`. If `realElapsed >= windowMs`, the window genuinely elapsed → proceed with the existing expiry (reject pre-handle / synthetic `failed` + best-effort cancel post-handle). If `realElapsed < windowMs`, the timer fired before real time reached the window (host suspend / clock jump) → **re-arm** `setTimeout` for the remaining `windowMs - realElapsed` (clamped to `MAX_TIMER_DELAY_MS`) and log a warn. The `capExpiry` promise stays pending across re-arms, so a `handle.result` that settles in the meantime still wins the race and the run completes normally.
- **Absolute runaway backstop.** Cap the number of *misfire* re-arms (`MAX_CAP_REARMS`); once exceeded, force expiry regardless. This bounds re-arming against a pathological / frozen monotonic clock (which would otherwise never reach `windowMs`). A misfire re-arm is distinguished from a healthy clamped-segment re-arm: a cap beyond `MAX_TIMER_DELAY_MS` is served as a sequence of clamped physical waits, and a segment where the full armed delay elapsed in real time is *not* a misfire — it re-arms without warning and without spending the backstop. On a healthy sub-`MAX_TIMER_DELAY_MS` cap the misfire path is exercised ~never (the timer and `performance.now` agree); on a suspend the count equals the number of suspends during the run — realistically single digits — so the backstop never trips in normal operation.
- **Preserve every existing invariant:** the resume grace floor (`MIN_RESUMED_CAP_WINDOW_MS`, clamped to the cap), the pre-handle (`CursorRunStartTimedOutError`) vs post-handle (synthetic `failed`) distinction, the `MAX_TIMER_DELAY_MS` clamp on the physical wait, the synthetic `durationMs` reporting the configured cap (not the clamp), and the late-loser-rejection swallowers.

## Why monotonic re-validation (and not wall-clock reconciliation)

The dogfood env jumps the **wall clock** ~2.28h between turns. A wall-clock anchor (`Date.now()` delta) would read the jump as elapsed and expire too — it can't tell a jump from genuine passage. `performance.now()` is the jump-immune source, and #157 already proved it is stable enough in these environments to drive the driver-tick fix.

## Considered alternative — deferred

Drive the cap off the cloud run's own liveness (`getRun().updatedAt` / event stream), like #157's tick drives off last-event-age, instead of any local clock. This is strictly more robust for the pathological case where *every* local clock (including the monotonic one) jumps with a VM pause, and for a still-emitting run that should survive regardless of local time. It is deferred because it is a materially larger change — it couples the core cap to a progress signal / the cloud runner's `getRun`, threaded through both cap call sites — and the monotonic re-validation satisfies the acceptance criteria for the stated scenario (a machine whose **wall** clock jumps) at a fraction of the blast radius. If a monotonic-clock-also-jumps environment is observed on real hardware, promote this alternative to its own task.

## Acceptance

- A cap timer that fires after a host suspend / wall-clock jump with no real (monotonic) elapsed run time does NOT produce `timeout-near-cap` — it re-arms for the remaining window.
- A run that genuinely consumes `maxRunDurationMs` of real (monotonic) time IS still capped to `timeout-near-cap`.
- Resume still uses the `MIN_RESUMED_CAP_WINDOW_MS` grace; a result landing inside any (re-armed) window still beats the synthetic terminal.
- The deciding measurement uses a monotonic source, not the system wall clock.

## Test plan

- `make check` green.
- Unit tests (fake timers + injected monotonic clock — `performance.now` is not faked by vitest, so tests inject `() => Date.now()`, which the fake-timer `Date` advances):
  - Timer fires but the monotonic clock shows ~0 elapsed (a wall-jump misfire) → no synthetic failure; the cap re-arms; a later monotonic advance past `windowMs` then expires.
  - Monotonic clock advances in real proportion past `windowMs` → `timeout-near-cap` synthetic terminal, exactly as today.
  - Repeated misfires beyond `MAX_CAP_REARMS` → forced expiry (backstop).
  - Regression: every existing cap test (pass-through, start/result rejection, pre/post-handle expiry, resume grace, `MAX_TIMER_DELAY_MS` clamp, late-loser swallowing) still passes with the monotonic clock advancing in step with the fake timers.

## Risks

- **Monotonic clock also jumps (some VMs/sandboxes):** not fixed here (see deferred alternative). The operator's real unattended-run targets (Linux hosts / a sleeping laptop) have a monotonic clock that pauses on suspend, which this fixes.
- **`MAX_CAP_REARMS` too low:** would force expiry on a run legitimately spanning many suspends. Mitigated by a generous default; the count only increments on genuine misfires.

## Out of scope

- Driver-tick liveness (shipped in #157).
- Cloud `getRun`-driven liveness (deferred alternative above).
- Any change to `policy.maxRunDurationMs` semantics — it remains the total real-run-duration cap.

## Implementation plan

1. `duration-cap.ts`: add `monotonicClock?` to `DurationCapRunArgs`; capture `startedMono`; add `MAX_CAP_REARMS`; convert the expiry callback into a named `onCapTimer` that re-validates monotonic elapsed and re-arms (or expires) with a re-arm counter; keep the `finally` clearing the latest timer.
2. `duration-cap.test.ts`: route existing calls through a helper that injects `monotonicClock: () => Date.now()`; add the three new cases above.

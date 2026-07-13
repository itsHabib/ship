---
driver_version: 1
generated_at: 2026-07-13T05:20:00Z
generated_by: work-driver-prep
source:
  project: ship
  phase: cross-phase (driver-hardening cluster, tasks span 4 phases)
repo: ship
repo_url: https://github.com/itsHabib/ship
branch_prefix: driver-hardening-
default_runtime: local

batches:
  - id: 1
    label: parallel-safe — judgment predicate, orphan refresh, review-findings residual
    depends_on: []
    status: pending
    streams:
      - task_id: tsk_01KVB6VXQ0F88QSCGANET3QVC7
        task_slug: driver-multidecide-dispatching-and-cancelled-guard
        spec_path: docs/features/driver-hardening-2026-07/driver-multidecide-dispatching-and-cancelled-guard.md
        runtime: cloud
        model: sonnet
        effort: extra
        touches: [packages/driver/src/judgment.ts]
        status: pending
      - task_id: tsk_01KV4R52CFTAPT8NE5MTTNFF8G
        task_slug: driver-orphan-refresh-non-streaming
        spec_path: docs/features/driver-hardening-2026-07/driver-orphan-refresh-non-streaming.md
        runtime: cloud
        model: opus
        effort: max
        touches: [packages/core/src/service.ts, packages/core/src/cursor-runs/cloud-runner.ts, packages/driver/src/engine.ts]
        status: pending
      - task_id: tsk_01KX76CFTCQ0TPH780MWGHKZVY
        task_slug: review-findings-v1-impl
        spec_path: docs/features/driver-hardening-2026-07/review-findings-v1-residual.md
        runtime: cloud
        model: sonnet
        effort: extra
        touches: [packages/driver/src/address (attempt-start path), docs/features/ccp-loop-closure/phases/review-findings-v1.md]
        status: pending
  - id: 2
    label: after 1 — inactivity watchdog + rolls_up/base_branch (disjoint pair)
    depends_on: [1]
    status: pending
    streams:
      - task_id: tsk_01KVPNYZ0CJ1G7BEG39WP36AP5
        task_slug: liveness-aware-run-cancel
        spec_path: docs/features/driver-hardening-2026-07/liveness-aware-run-cancel.md
        branch_name: driver-hardening-liveness-aware-run-cancel
        runtime: local
        model: opus
        effort: max
        touches: [packages/core/src/cursor-runs/duration-cap.ts, packages/core/src/service.ts, packages/workflow (policy)]
        status: pending
      - task_id: tsk_01KVB5BH4ZXMSVDMZ0YHD2D0MM
        task_slug: driver-rolls-up-base-branch
        spec_path: docs/features/driver-hardening-2026-07/driver-rolls-up-base-branch.md
        branch_name: driver-hardening-rolls-up-base-branch
        runtime: local
        model: sonnet
        effort: extra
        touches: [packages/store/src (migration 0007, driver-schemas.ts, driver-streams.ts), packages/driver/src/import.ts, packages/driver/src/engine.ts, packages/driver/src/render.ts]
        status: pending
  - id: 3
    label: after 2 — remote-progress signal (builds on watchdog's last-event plumbing)
    depends_on: [2]
    status: pending
    streams:
      - task_id: tsk_01KWFV8KRDAM46V088DB5159PB
        task_slug: event-pump-blinds-tick-liveness
        spec_path: docs/features/driver-hardening-2026-07/event-pump-blinds-tick-liveness.md
        branch_name: driver-hardening-event-pump-tick-liveness
        runtime: local
        model: opus
        effort: max
        touches: [packages/core/src/cursor-runs/event-pump.ts, packages/core/src/service.ts, packages/driver (pollOneStream/noteWorkflowRunProgress), packages/store (possible last_event_at column)]
        status: pending
  - id: 4
    label: after 3 — circuit breaker (step-1 investigation locks scope first)
    depends_on: [3]
    status: pending
    streams:
      - task_id: tsk_01KWT8427209X2BS8QYFC2YSRT
        task_slug: dispatch-failure-circuit-breaker
        spec_path: docs/features/driver-engine-tail-hardening/dispatch-failure-circuit-breaker.md
        branch_name: driver-hardening-dispatch-circuit-breaker
        runtime: local
        model: opus
        effort: max
        touches: [packages/driver/src/engine.ts, packages/driver/src/escalation.ts, packages/store (StreamAttempt) — conditional on step-1 finding]
        status: pending

conflict_notes:
  - kind: file_overlap
    file: packages/core/src/service.ts
    tasks: [driver-orphan-refresh-non-streaming, liveness-aware-run-cancel, event-pump-blinds-tick-liveness]
    note: "all three touch the onEvent/onHandle/heartbeat region — strictly serialized across batches 1→2→3"
  - kind: file_overlap
    file: packages/driver/src/engine.ts
    tasks: [driver-orphan-refresh-non-streaming (tick call site), review-findings-v1-impl (address attempt-start guard), driver-rolls-up-base-branch (buildShipInput), dispatch-failure-circuit-breaker (dispatch path)]
    note: "batch 1 runs orphan-refresh + review-findings in parallel on the bet that tick call-site and address-guard are textually disjoint regions of engine.ts; if that's wrong, second-to-merge rebases. rolls-up and circuit-breaker are in later batches regardless."
  - kind: dep_signal
    from: event-pump-blinds-tick-liveness
    to: liveness-aware-run-cancel
    reason: "soft: if the watchdog PR persists a last-event timestamp, the pump fix's option (b) should reuse it instead of adding a second one"
  - kind: dep_signal
    from: dispatch-failure-circuit-breaker
    to: cloud-sdk-cause-persistence (tsk outside this manifest)
    reason: "task body: 'a park that says 3× HTTP 400 beats 3× sdk-throw — land that first if sequencing'. NOT blocking: breaker ships regardless; escalation text improves later. Placed last partly for this."
  - kind: scope_gate
    from: dispatch-failure-circuit-breaker
    to: step-1 source confirmation
    reason: "spec's step 1 (driver-owned vs caller-owned re-fire) is BLOCKING before code; the dispatched agent must do the investigation first and lock scope in the PR body"

skipped_during_resolution:
  - reason: "liveness-aware-run-cancellation (tsk_01KW13XYWH131ARG92KQ2T39E2) cancelled as duplicate of liveness-aware-run-cancel; its monotonic-clock note folded into the survivor's spec"
    workaround: "none needed"
---

# Driver-hardening 2026-07 — driver manifest

Generated by `/work-driver-prep` (explicit task IDs, ship driver-hardening cluster) on 2026-07-12.
Consumed by `/work-driver docs/features/driver-hardening-2026-07/driver.md`.

Goal of the cluster: unattended-run reliability — the "fire a batch and walk away"
gap. Every task here is a documented incident where a run died, hung, false-cancelled,
or re-fired silently and needed a human poke.

## Batches

1. **Parallel-safe, 3 streams (cloud)** — `driver-multidecide-dispatching-and-cancelled-guard`
   (judgment.ts predicate + markMerged guard, sonnet/extra),
   `driver-orphan-refresh-non-streaming` (one-shot Agent.getRun harvest, opus/max),
   `review-findings-v1-impl` residual (stale-head re-validation at attempt start,
   sonnet/extra). Cloud: 3 parallel streams would serialize locally.
2. **2 streams, disjoint (local)** — `liveness-aware-run-cancel` (inactivity watchdog
   replacing the wall-clock cap, opus/max; core-only) ∥ `driver-rolls-up-base-branch`
   (store migration + cloud startingRef, sonnet/extra; store+driver-only). After
   batch 1 because orphan-refresh touches service.ts and engine.ts first.
3. **1 stream (local)** — `event-pump-blinds-tick-liveness` (remote-progress signal
   for #157 tick liveness, opus/max). After the watchdog so it can reuse any
   persisted last-event timestamp.
4. **1 stream (local)** — `dispatch-failure-circuit-breaker` (opus/max). Spec already
   existed at `docs/features/driver-engine-tail-hardening/`; its step-1
   (driver-owned vs caller-owned) is blocking before code. Last so
   cloud-sdk-cause-persistence has a chance to land first if picked up separately.

## Runtime notes

- Batch 1 is cloud (parallelization signal: 3 streams). Cloud embeds spec content
  local-first — batch 1 needs no docs commit.
- Batches 2–4 are local — **their specs must be on origin/main before dispatch**:
  open a docs PR (`docs(driver-hardening): spec docs for 6 tasks`) and merge it
  before running batch 2. Never push main directly.

## Experiment data (populated by /work-driver)

Per-stream: dispatch attempts, correction rounds, review findings by severity,
wall time. Provenance footer per PR:
`Provenance: seat=driver model=<seat-model> implementer=<model> provider=cursor pipeline=work-driver`.

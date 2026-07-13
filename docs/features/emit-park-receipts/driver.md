---
driver_version: 1
generated_at: 2026-07-13T19:30:00Z
generated_by: work-driver-prep
source:
  project: ship
  phase: emit-park-receipts
repo: ship
repo_url: https://github.com/itsHabib/ship
branch_prefix: emit-park-receipts-
default_runtime: local

batches:
  - id: 1
    label: ready now
    depends_on: []
    status: pending
    streams:
      - task_id: tsk_01KXDYHV5Y3EP1C9Z3WKJ1ADKJ
        task_slug: emit-park-receipts
        spec_path: docs/features/emit-park-receipts/spec.md
        branch_name: emit-park-receipts
        runtime: local
        model: sonnet
        effort: extra
        touches: [packages/receipt/src/schema.ts, packages/driver/src/engine.ts, packages/driver/src/engine.test.ts, packages/receipt/src/schema.test.ts]
        status: pending

conflict_notes:
  - kind: dep_signal
    from: flare-lift-park-receipts (workbench project)
    to: emit-park-receipts
    reason: "Cross-repo consumer — workbench flare-lift-park-receipts (tsk_01KXDYH4X6KVWJ7357ZBSNGAK1) matches this PR's outcome string verbatim; pinned to `parked`. Prep it once this merges."
---

# emit-park-receipts driver manifest (ship repo)

Generated for the workbench `talk-readiness` phase's push-on-block gap (ship half). The
flare half (`flare-lift-park-receipts`) lives in the workbench repo and is gated on this
merging + the `parked` outcome string.

## Batches

**Batch 1 — ready now, 1 stream (local):**
- `emit-park-receipts` → `docs/features/emit-park-receipts/spec.md` — touches
  `packages/receipt/` (outcome enum) + `packages/driver/` (emit at the awaiting_judgment
  transition) — sonnet/extra. No conflicts (single stream). Outcome string pinned to
  `parked`; record it in the PR body for the flare consumer.

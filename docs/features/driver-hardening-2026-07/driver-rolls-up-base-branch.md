**Status**: draft
**Owner**: @michael
**Date**: 2026-07-12
**Related**: dossier task `driver-rolls-up-base-branch` (id: `tsk_01KVB5BH4ZXMSVDMZ0YHD2D0MM`); deferred from `driver-manifest-forward-compat` by adversarial pre-flight `wf_8f867391-0cf` (manifest-audit blocker + batching-audit); friction F12, F17.

# First-class `rolls_up` + `base_branch` — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | migration `0007_*.sql` (ADD COLUMN on `driver_streams`), `packages/store/src/driver-schemas.ts`, `packages/store/src/driver-streams.ts` (STREAM_COLUMNS, INSERT, `insert()`, `applyStreamPatch`, `optionalStreamFields`, `DriverStreamRow`), `packages/driver/src/import.ts` (`buildStreamInput`), `engine.ts` (`buildShipInput` → `repos[0].startingRef`), `status --json` + `render.ts` | ~320 | 320 |
| Tests | round-trip via store rows, `status --json` reads real column, `buildShipInput` startingRef vs `CloudRunSpec` | ~250 | 125 |
| **Total** | | | **~445** |

Band: **amazing** (< 500), but wide-blast across store+driver. **Ship as 2 PRs if the first crosses the band**: PR-a `rolls_up` store persistence (the bulk), PR-b `base_branch` cloud ref-selection (store-free, small). Prefer the split; a single PR needs a no-split note.

## Goal

Forward-compat (warn-on-unknown-keys) made `rolls_up` / `base_branch` warn-accepted manifest keys; this promotes them to first-class. `rolls_up: [task_id]` is the collapsed-stream → N-task-ids mapping the engine needs at land time to close all rolled-up dossier tasks (the `task_complete` itself stays skill-side). `base_branch` selects the cloud starting ref.

## Behavior / fix

1. **`rolls_up` persistence (store — the bulk).** New migration `0007_*.sql` ADD COLUMN on `driver_streams`. `driverStreamSchema` is `.strict()` — add the field. Thread through `driver-streams.ts` (STREAM_COLUMNS, INSERT, `insert()`, `applyStreamPatch`, `optionalStreamFields`, `DriverStreamRow`) and `import.ts` (`buildStreamInput` carries it). Surface in `status --json` — which serializes **store rows**, not `sourceJson` — and `render.ts`.
2. **`base_branch` cloud ref-selection (store-free).** `engine.ts buildShipInput` cloud branch sets `repos[0].startingRef`, sourced via a manifest re-parse like `extractRepoUrl`. `cloudRunSpecSchema` / `CloudRunSpec` already expose `startingRef` — unit-test against `buildShipInput`. Local-worktree base honoring is a no-op in ship (worktrees come from `/worktree-add`); ship only persists the value.

## Acceptance

- A manifest stream with `rolls_up: [tsk_A, tsk_B]` round-trips: import → store row → `status --json` shows it from the **real column** (the source-json-only shortcut satisfies `render` but FAILS this acceptance).
- A cloud stream with `base_branch` produces `repos[0].startingRef` in the built ship input.
- Migration applies cleanly on an existing store; older rows read back with the field absent.
- `make check` green.

## Non-goals

- Skill-side `task_complete` fan-out for rolled-up tasks (stays in `/work-driver`).
- Local-worktree base-branch enforcement (no-op by design).

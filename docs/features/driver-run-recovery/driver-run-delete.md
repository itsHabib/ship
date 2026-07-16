# driver rm — delete a wedged driver run

**Status**: draft
**Owner**: @itsHabib
**Date**: 2026-07-16

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `store/driver-runs.ts`, `store/store.ts`, `driver/service.ts`, `cli/commands/driver.ts`, `cli/format.ts` | ~30 | 30 |
| Tests | `store/driver-runs.test.ts`, `driver/service.test.ts`, `cli` verb test | ~80 | 40 |
| **Total** | | | **~70** |

Band: **amazing** (< 500).

## Problem

`driver run <manifest>` is idempotent on the identity tuple **(repo, project, phase, generated_at)** — `importManifest → findExistingRun` returns any prior run with a matching `generated_at`, *regardless of that run's status* (`import.ts:74`, `178`). That idempotence is correct for the normal "re-tick to keep polling" flow, but it has no escape hatch:

- A run that wedges (a stream stuck `pending` / `awaiting_judgment` after a bad dispatch) permanently **shadows** any re-import of the same manifest. You cannot get a fresh run without editing `generated_at` by hand.
- The wedged run keeps its original **immutable `manifest_path`**. When that path was captured wrong (the F1 linked-worktree path-doubling bug, now fixed in #217), even a corrected re-invocation can't rebind it.
- `driver cancel` sets `status = cancelled` but **keeps the row**, so the dedup shadow persists. There is no CLI verb to delete or reset a run.

Concretely, right now: the `dispatch-decide-core` stream sits `pending` on a wedged run with two sibling runs stranded at `awaiting_judgment`, and the only way out is direct SQL against `state.db`. That store surgery is exactly what a solo operator should never have to do to recover from a mis-fire.

## Functional

Add `ship driver rm <driverRunId>` — delete a driver run and its children.

- Deletes the `driver_runs` row; `ON DELETE CASCADE` (0005 migration, `foreign_keys = ON` in `db.ts:59`) removes its `driver_batches`, `driver_streams`, and any `escalations` / `driver_review_artifacts` that reference it. Verified: every table referencing driver rows cascades, so one `DELETE` is complete and orphan-free.
- Prints the deleted run's identity (`id`, `repo`, `project`, `phase`, `status`, stream count) so the destructive act is auditable in the terminal.
- Unknown id → `DriverRunNotFoundEngineError` (non-zero exit), same as `status`.

**Recovery is a composition, not a new mega-verb:** `driver rm <drv>` then `driver run <manifest>` re-imports fresh. With F1 landed, that re-import reads the correct main-worktree path. `rm` owns exactly one responsibility (remove a run); the existing `run` owns re-import.

## Engineering decisions

- **Delete, not auto-supersede-on-reimport.** Making `importManifest` silently discard a matching terminal run would surprise the common re-tick flow and risk nuking a run on an *accidental* `generated_at` collision. An explicit, id-targeted `rm` is predictable and safe; the operator names the ulid they mean to destroy (like `git branch -D` / `docker rm`).
- **Delete, not in-place reset.** A reset would have to mutate the currently-immutable `manifest_path` and re-derive batches/streams — reinventing import. Delete + the existing import path reuses proven code and is the thing that actually fixes a bad-path binding.
- **Cascade over manual child deletes.** The schema already declares `ON DELETE CASCADE` on every referencing table and the connection enables `foreign_keys`. A single statement is correct; hand-deleting children would duplicate the schema's own guarantee and risk drift.
- **Store method mirrors `workflow-runs.deleteById`.** Same shape (`DELETE … WHERE id = ?`, returns `changes > 0`); no new pattern introduced.
- **Return the deleted run from the service** (get-then-delete) so the CLI can print identity without a second lookup. The get→delete is non-atomic, which is irrelevant for a single-operator recovery verb targeting a known-wedged (non-ticking) run.

## Validation

- **Store**: `deleteById` returns `true` and cascade-removes the run's batches + streams (assert `getDriverRun` is null and direct child-row counts are 0); returns `false` for an unknown id.
- **Service**: `deleteDriverRun` returns the deleted run; throws `DriverRunNotFoundEngineError` for an unknown id (covers both branches for the ≥82% branch threshold).
- **CLI**: `driver rm <id>` prints the identity line and exits 0; unknown id prints the not-found message and exits non-zero.
- `make check` green (typecheck + lint + format + test + coverage).
- **End-to-end**: after merge, `driver rm` the wedged `dispatch-decide-core` runs, then re-fire the local dispatch drive — the original dogfood this unblocks.

## Risks

- **Destructive + irreversible.** Mitigated by explicit-id targeting and the printed identity line. No bulk/glob form — one id per call, deliberately.
- **Deleting a live-ticking run.** Out of scope (below); a wedged run is not ticking, and the operator targets it deliberately.

## Out of scope

- **Live-tick guard.** Refusing to `rm` a run whose tick lease is live would couple the CLI to the engine's staleness constant; deferred until there's a real concurrent-drive collision to justify it.
- **MCP parity (`driver_delete`).** The local drive runs through the CLI (the MCP connector and the terminal CLI use different stores — the MSIX-virtualization gotcha), so the CLI verb is what unblocks recovery. An MCP verb is a separate follow-up when the stores converge.
- **F1** (linked-worktree path resolution) — already shipped in #217.
- Bulk deletion, TTL-based pruning, `--force` — no demand yet; add if a real need appears.

## Implementation plan

1. **Store** (`driver-runs.ts` + `store.ts`): add `deleteById(id): boolean` to `DriverRunOps` and expose `deleteDriverRun(id)` on `Store`. + store tests (cascade + unknown-id).
2. **Service** (`driver/service.ts`): add `deleteDriverRun(id): DriverRun` to the `DriverService` interface + impl (get → throw-if-null → delete → return). + service tests (both branches).
3. **CLI** (`cli/commands/driver.ts` + `format.ts`): register `driver rm <driverRunId>`; add `formatDriverDeleteOutput`. + verb test.

One PR — the three steps are one thin vertical slice.

**Status**: draft
**Owner**: @michael
**Date**: 2026-06-02
**Related**: dossier task `observability-failure-category-enum` (id: `tsk_01KTJH8HWKD3DANMPJ15WE5WD9`); locked design [docs/features/observability/spec.md](../spec.md) §5, §6, §7, §4 D5.

# failure-category enum + classifier + finalize wiring

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/workflow/src/workflow.ts` (enum), `packages/cursor-runner/src/*` (classifyFailure, `CursorRunResult` fields, cloud-EXPIRED), `packages/core/src/service.ts` (finalize wiring), `packages/store/src/*` (column + migration) | ~250 | 250 |
| Tests | classifier table + wiring/persistence + cloud-EXPIRED | ~230 | 115 |
| **Total** | | | **~365** |

Band: **amazing** (< 500). **Split option:** if it balloons past ~700 weighted, split into (1) enum + `classifyFailure` + classifier tests, and (2) core finalize wiring + store column/migration + cloud-EXPIRED — see Implementation plan.

## Goal

Run failures are classified ad-hoc per surface (#103 / #105 each invent their own string). Introduce **one canonical `failure-category`** — the connective tissue threaded through logs, `get_workflow_run`, and (later) stats — derived from signals ship already captures, classified where the data + store access meet.

## Behavior / fix (per locked design §5/§6/§7, §4 D5)

1. **Enum** in `@ship/workflow` (alongside `workflowStatusSchema` etc.):
   ```ts
   failureCategorySchema = z.enum(["contention","timeout-near-cap","agent-collapse-on-running-tool","sdk-throw","logic","unknown"])
   ```
   **No `cancelled`** (cancellation is `run.status === "cancelled"`, never reaches the failure classifier). Literals are **tombstones** — persisted in SQLite; never delete/rename, only add (mirror `phaseKindSchema`).
2. **`classifyFailure`** — pure function exported from `@ship/cursor-runner`:
   ```ts
   classifyFailure(input: {
     sdkTerminalStatus?: string;   // ANY case — normalized internally (.toLowerCase())
     isStoreContention?: boolean;  // set by core; keeps cursor-runner free of an @ship/store dep
     thrownError?: boolean;        // thrown SDK error (reject path) → sdk-throw
     durationMs?: number;          // matches CursorRunResult.durationMs (NOT the get_workflow_run output runDurationMs)
     maxRunDurationMs?: number;
     events: readonly SDKMessage[]; // bounded; empty is valid → unknown (total)
   }): FailureCategory
   ```
   Priority: `isStoreContention`→`contention`; `thrownError`→`sdk-throw`; latest **failed** `tool_call`→`logic`; running `tool_call` with `durationMs > 0.8×cap` AND last-running-tool age > 30s→`agent-collapse-on-running-tool`; `expired` (normalized) or `durationMs ≥ 0.95×cap`→`timeout-near-cap`; else `unknown`. **No `cause`/`isCancelled`** — `core` owns those guards. Total: never throws / returns undefined.
3. **`core` finalize wiring** — call `classifyFailure` from **BOTH** paths: `finalizeSuccess` (failed `CursorRunResult`) and `finalizeFailure` (thrown SDK/store error, no result — the primary path for `sdk-throw`/`contention`; `core` sets `isStoreContention`/`thrownError`). Persist the category in a **new nullable `failure_category` column** (migration; #100 skew-guard covers upgrade). `CursorRunResult` + `result.json` gain `failureCategory?` + bounded `failureDetail?` (last-activity / errorMessage summary) — built here so the Phase-1 gate holds.
4. **Cloud `EXPIRED`** — `cloud-runner.ts` currently maps `EXPIRED → cancelled` (bypasses the classifier). **Reclassify it as a failure** (route through `mapErrorResult`) so it reaches `timeout-near-cap`. Behavioral change. The cloud runner must also retain a bounded event window (local already keeps a 256-event ring buffer; `mapCloudRunResult` passes none).

## Acceptance

- Enum in `@ship/workflow` (no `cancelled`, tombstone discipline). `classifyFailure` total (empty events → `unknown`). Category persisted (new column). **Both** finalize paths classify. Cloud `EXPIRED` → `timeout-near-cap`. `errorMessage` carries `<category>; <failureDetail>`. No `cursor-runner` → `@ship/store` dep edge. `make check` (incl. coverage) green.

## Test plan

Classifier unit table: each signal → expected category, incl. `unknown` fallback + empty-events totality + case-normalization. Wiring: failed-result via `finalizeSuccess` and thrown-error via `finalizeFailure` both persist a category; cloud-`EXPIRED` lands `timeout-near-cap`; `failureDetail` populated.

## Implementation plan (PR boundaries if split)

1. enum (`@ship/workflow`) + `classifyFailure` (`@ship/cursor-runner`) + classifier tests.
2. core finalize wiring (both paths) + store `failure_category` column/migration + `CursorRunResult` fields + `failureDetail` builder + cloud-`EXPIRED` reclassification.

Ship as one PR if ≤ ~700 weighted; otherwise two, (2) depending on (1).

## Non-goals

- Surfacing the category/detail on `get_workflow_run` / `errorMessage` presentation + `ship diagnose` (Phase 2, `observability-run-diagnosis`).
- Migrating the ~24 ad-hoc log sites (separate task).

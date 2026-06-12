**Status**: ready for impl — P1 merged as #129 (squash `405563e`); §"P1 surface consumed" verified against the merged exports
**Owner**: @michael
**Date**: 2026-06-10
**Related**: dossier task `driver-run-store-entity` (id: `tsk_01KTRZRD61V3W571FD9BNXRGY6`); locked design [docs/features/driver-extraction/spec.md](../spec.md) — §4.2, §5 (v2), §9 P2; depends on P1 [driver-manifest-schema-parser.md](driver-manifest-schema-parser.md).

# F2: driver_runs / batches / streams store entity + importManifest + render

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/store/migrations/0005_driver_runs.sql` (~55), `packages/store/src/driver-runs.ts` + `driver-batches.ts` + `driver-streams.ts` + errors + store wiring (~330), `packages/driver/src/import.ts` (~120), `packages/driver/src/render.ts` (~150) | ~655 | — but see split note |
| Tests + fixtures | store-verb L1/L2 (in-memory db), migration test, composite-FK test, import/render tests, fast-check round-trip property | ~600 | 300 |
| Configs / docs | `package.json` dep edges, lockfile | — | 0 |
| **Total** | | | **~700 — top of ideal band** |

No-split justification (declared per repo convention): the migration, the verbs over it, and the import/render pair are one schema you can't ship half of — verbs without the migration don't compile a test, import without render can't prove the round-trip property that is this phase's acceptance gate. If implementation busts ~750 weighted, the permissible seam is render.ts + property test as a fast-follow PR (import + verbs + migration must stay together).

## Goal

Spec §4.2 / F2: progress state moves out of `driver.md` YAML (mutated today by LLM text edits — one malformed edit silently corrupts resume) into `driver_*` tables. After this phase the store is the source of truth; the manifest becomes a render. The engine (P3) consumes the verbs; no engine logic lands here.

## P1 surface consumed

From `@ship/driver` (P1, verified against #129's merged `src/index.ts`): `parseManifest`, `ParseManifestResult`, `ManifestParseError`, `DriverManifest` / `ManifestBatch` / `ManifestStream` types, the schema objects (`driverManifestSchema`, `manifestBatchSchema`, `manifestStreamSchema`), and `rawFrontmatter` on the ok-result. P1's stream-status manifest vocabulary is `pending | todo | in_progress | done | failed | skipped` — exactly what the render mapping below assumes.

## Behavior

### 1. Migration `0005_driver_runs.sql`

Exactly spec §5 (v2 form): `driver_runs`, `driver_batches`, `driver_streams` with TEXT pks (`drv_` / `db_` / `ds_` ulids), ISO-string timestamps, JSON columns, `ON DELETE CASCADE`, the two indexes on `driver_streams`, **and the v2 integrity pair**: `UNIQUE (driver_run_id, id)` on `driver_batches` + composite FK `(driver_run_id, driver_batch_id) REFERENCES driver_batches (driver_run_id, id)` on `driver_streams`, so a stream can never reference a batch belonging to a different run.

Stream `status` uses the v2 enum (run-level `awaiting_judgment` removed from streams): `pending | dispatching | dispatched | landed | failed | skipped | done`. Run status: `pending | running | awaiting_judgment | done | failed | cancelled`. Batch status: `pending | running | done | failed`. Enum values are tombstones once shipped — enforcement is CHECK-free (matching 0001's convention of validating in zod, not SQL) unless 0001 sets a different precedent; follow whatever 0001 actually does.

One clarification to §5, consistent with its v2 render-fidelity note and to be sanity-checked in review: **`source_json` stores the full original manifest file text verbatim** (frontmatter *and* markdown body, pre-parse) — not just the frontmatter block. The v2 note's intent is render fidelity across schema upgrades; storing the whole file additionally preserves the human-written body (topology tables, prep notes) that render would otherwise drop. The column name stays `source_json` per the locked schema.

### 2. Store verbs (`@ship/store`)

Per-table modules following the existing conventions exactly (see `phases.ts` as the template): one module per table owning every SQL string that touches it; cached prepared statements; mutations transactional; every mutation bumps `driver_runs.updated_at`; zod hydration at read time throwing `StoreSchemaError` on bad rows; typed not-found errors (`DriverRunNotFoundError`, `DriverStreamNotFoundError`, ... in `errors.ts`); byte-wise deterministic ordering (`batch_index`, then stream `created_at, id`). Surface (exposed through `Store` like the existing ops, wrapped by `withStoreContentionGuard` at the same layer the existing verbs are):

- `insertDriverRun(aggregate)` — run + batches + streams in one txn (import's write path).
- `getDriverRun(id)` — hydrated aggregate (run, batches with their streams) or typed not-found.
- `listDriverRuns({ repo?, status?, limit? })` — spec §6 filter shape.
- `updateDriverRunStatus(id, status)`; `updateDriverBatch(id, patch)`; `updateDriverStream(id, patch)` — narrow patches over the progress columns (`status`, `workflow_run_id`, `attempts`, `pr_number`, `pr_url`, `merge_commit`, `merged_at`, `cycles`, `error_message`, `completed_at`). These are F2's point — progress lives here — and P3/P4 consume them as-is.

Nothing speculative beyond that list: no tick-lease columns/verbs (§8's `tick_started_at`/`tick_ended_at` land with the engine that stamps them — if review prefers the columns in 0005 now to avoid a 0006, add the columns but still no verbs), no judgment-request storage (derived, not stored, per §6).

### 3. `importManifest` (`packages/driver/src/import.ts`)

`importManifest(store, manifestPath): DriverRun` — reads the file, `parseManifest`s it (P1; parse errors propagate as import failure with the P1 error detail), and inserts the aggregate in one transaction.

- **Idempotency by (repo, manifest identity)**, where identity = `(source.project, source.phase, generated_at)`: a re-import matching an existing run on all four is a **warn-and-noop** returning the existing run (the "warn" is a flag/field on the return, e.g. `{ run, alreadyImported: true }` — no logging policy decided here). A regenerated manifest (new `generated_at`) is a new run by design. Implementation: list runs by `(repo, project, phase)` and compare `generated_at` parsed from each stored `source_json` — no schema addition needed.
- **Absorbs progress fields when present** (migration path for in-flight manifests): manifest stream `status` maps `done→done`, `failed→failed`, `pending|todo→pending`, `in_progress→pending` (dispatch state is not recoverable from a manifest; the run re-dispatches); `pr_number`/`merge_commit`/`merged_at`/`cycles` copy onto the stream row; batch `status: done` + `completed_at` carry over; run status derives (`all batches done → done`, else `pending`).
- `manifest_path` column records import provenance (display only); `source_json` gets the full file text; `repo`/`project`/`phase` from the manifest.
- This package now adds its first workspace dep: `@ship/driver → @ship/store` (downward per spec §3; core is NOT touched).

### 4. `render` (`packages/driver/src/render.ts`)

`renderDriverRun(store, driverRunId): string` — store rows → `driver.md` text.

- Parse the stored `source_json` frontmatter **leniently** (passthrough — unknown fields from future schema versions survive; this is exactly why the raw text was stored), overlay the progress fields from the current rows (stream `status`/`pr_number`/`merge_commit`/`merged_at`/`cycles`, batch `status`/`completed_at`), re-serialize the frontmatter deterministically, and append the stored markdown body unchanged.
- **Byte-stable means deterministic**: the same store state always renders byte-identical output (two-render test). It does NOT mean byte-identical to the originally-imported file — YAML formatting canonicalizes on first render (flow-style lists may become block style, etc.); humans and `/shipped` read the same *shape* (spec §4.2).
- Store→render→parse(P1)→import→rows must be **lossless on progress fields** — the fast-check round-trip property and this phase's acceptance gate.
- Stream status mapping back to manifest vocabulary for render: store `done→done`, `failed→failed`, `landed` → `done`? — **no**: render writes store statuses verbatim EXCEPT `dispatching|dispatched`, which render as `in_progress` (the manifest vocabulary has no dispatch states, and a rendered manifest must round-trip through P1's schema — whose stream enum P1 fixed as `pending|todo|in_progress|done|failed|skipped`). `landed` also renders as `in_progress` (landed-but-unmerged is still in-flight in manifest terms). Document this mapping in a code-adjacent table; the property test pins that the mapping round-trips losslessly for the terminal/restable statuses (`pending`, `done`, `failed`, `skipped`) and degrades-to-`in_progress` for the transient ones (asymmetric by design — assert the documented mapping, not naive equality).

## Acceptance

- `0005` applies cleanly on a `0004` database (migration test) and on a fresh db.
- Composite-FK integrity: inserting a stream whose `driver_batch_id` belongs to a different run is rejected (test).
- An existing real driver.md fixture (reuse P1's `hygiene-followups.driver.md` — all-done, progress-rich) imports cleanly with all progress fields absorbed; an in-flight-shaped fixture (P1's synthetic, which has pending + failed streams) imports with correct status mapping.
- Re-import of the same manifest is a warn-and-noop (returns existing run, no row changes); re-import after editing only progress fields in the file: same identity → still noop (progress edits to the file are ignored post-import, per spec §4.2).
- Round-trip property (fast-check): arbitrary progress-state mutations applied via the update verbs → render → parse → import-shape comparison is lossless on progress fields per the documented status mapping.
- Two-render determinism: same state → byte-identical output.
- Every mutation bumps `driver_runs.updated_at`; reads hydrate through zod (`StoreSchemaError` on corruption); typed not-found errors.
- Mutation score not reduced; `make check` green ubuntu + windows.

## Test plan

- **packages/store**: L1/L2 over the verbs against in-memory sqlite (existing harness pattern); migration 0004→0005 test; composite-FK rejection; updated_at bump per mutation; hydration failure → `StoreSchemaError`; not-found errors; list filter combinations.
- **packages/driver**: import (fresh, progress-absorbing, idempotent-noop, parse-failure propagation, status mapping table); render (overlay correctness, body preservation, unknown-field survival, two-render determinism); fast-check round-trip property.

## Out of scope

- The engine (P3): no batch walking, no dispatch, no `ShipService`/`@ship/core` dependency, no polling, no judgment.
- CLI/MCP surfaces (P4) — `render --out`, `driver import` verbs etc.
- Tick-lease verbs (§8) and `mark-merged` (P4 records it via the update verbs).
- Mid-run input edits (spec §10c — explicitly v1-unsupported).
- Touching `@ship/receipt` (unchanged from P1's boundary).

## Implementation plan

1. Migration 0005 + store per-table modules + errors + Store wiring + store tests.
2. `import.ts` (+ `@ship/store` dep edge) + tests.
3. `render.ts` + status-mapping table + round-trip property + determinism test.
4. Doc + exports + `make check` clean.

Single PR. Title: `feat(driver,store): driver_runs store entity + importManifest + render (P2)`. Include this doc verbatim in the PR at `docs/features/driver-extraction/phases/driver-run-store-entity.md` (the contract of record per the repo's phase-doc convention).

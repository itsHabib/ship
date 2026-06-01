**Status**: draft
**Owner**: @michael
**Date**: 2026-05-31
**Related**: dossier task `startup-schema-skew-guard` (id: `tsk_01KSZQEFV0CWY5ZVG5NZFYT4MY`)

# Fail loud on migration skew at startup — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/store/src/store.ts`, `migrations.ts`, `errors.ts` | ~40 | 40 |
| Tests | `packages/store/src/migrations.test.ts` (or `store.test.ts`) | ~60 | 30 |
| **Total** | | | **~70** |

Band: **amazing** (< 500).

## Goal

A long-lived ship server running newer read code against a DB that hasn't applied the matching migration crashes with a cryptic `no such column: <x>` from a downstream SELECT (hit in prod 2026-05-30: `no such column: artifacts_json` from `get_workflow_run`). `createStore` already runs `runMigrations` on every open, so this only bites a process that booted before a migration landed — but the failure mode is opaque. Make schema skew fail loud and actionable.

## Behavior / fix

After `runMigrations` in `createStore` (`store.ts:138`), assert the DB schema is at the version the running code expects. Mechanism: the migration runner already tracks applied files in `_migrations`; compare the latest-applied migration name (or count) against a code-side constant (the highest migration the build ships). On mismatch — DB behind code — throw a clear `SchemaSkewError` (new, in `errors.ts`):

> `ship DB schema is behind the running code (DB at <N>, code expects <M>). Restart ship to apply pending migrations.`

This replaces the downstream `no such column` with a single, named, actionable error at open time.

Edge: DB *ahead* of code (downgrade) — also worth a distinct clear error, but lower priority; a one-line note is fine.

## Acceptance

- Opening a store whose DB is at migration N while code expects N+1 throws `SchemaSkewError` with a restart hint — **not** a later `no such column`.
- The happy path (DB current) is unchanged.
- **Regression test for the existing-DB upgrade path** (the gap that let the prod bug through): open a DB at migration N (subset of the real migrations via a temp dir), reopen with the full set, assert the new column exists + a cursor-run round-trips. Every existing test uses a fresh `:memory:` DB with all migrations pre-applied, so this path is currently untested.

## Test plan

- `store_open_with_behind_db_throws_schema_skew_error`
- `store_open_applies_pending_migration_then_reads_ok` (the upgrade-path regression)

## Non-goals

- Auto-restart / auto-migrate-and-retry — the operator restarts; the guard just makes the need obvious.
- Online schema migration of a running process.

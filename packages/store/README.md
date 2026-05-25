# `@ship/store`

## What this package owns

SQLite persistence for workflow runs, phases, and cursor-run rows. Hand-written SQL via `better-sqlite3`, hydrated through `@ship/workflow` Zod schemas on read. Migrations live alongside the schema; the public API is the synchronous **`Store`** interface.

## Public surface

**Lifecycle**

- `createStore(options)` — open/create DB at path (or `:memory:`).
- `close()` — release the connection.

**Workflow runs**

- `createWorkflowRun`, `updateWorkflowRunStatus`, `markRunStarted`, `getRun`, `listRuns`, `cancelRun`, `touchWorkflowRunUpdatedAt`

**Phases**

- `appendPhase`, `updatePhase`

**Cursor runs**

- `recordCursorRun`, `updateCursorRunStatus`, `getCursorRun`
- **`listResumableCloudCursorRuns()`** — returns cloud rows with `runtime = 'cloud'`, status `running`/`pending`, and a non-null SDK `run_id`. Consumed by `ShipService.resumeOrphanedRuns` (V2 phase 08) to re-attach after process restart.

**Errors** — `WorkflowRunNotFoundError`, `PhaseNotFoundError`, `CursorRunNotFoundError`, `MigrationError`, `StoreSchemaError`.

## How it composes

Depends only on `@ship/workflow` for domain types. Consumed exclusively by `@ship/core` in production; `@ship/test-harness` opens `:memory:` stores for tests. No knowledge of MCP wire formats or the Cursor SDK — rows store JSON blobs validated on hydration.

## When to swap it

Replace this package to move off SQLite — Postgres, libsql, or an external workflow service — as long as the `Store` interface semantics hold. Core and MCP layers stay unchanged at the seam. Schema additions (new columns, phase kinds) land here + matching Zod schemas in `@ship/workflow`.

## Develop / test

```bash
pnpm --filter @ship/store test
```

Property tests in `src/cursor-runs.properties.test.ts` cover resumable-run query invariants. Tests use `:memory:` — no filesystem cleanup.

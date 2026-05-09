# Phase 3 — `packages/store`

Status: design draft, revision 0. Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-06

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec; the SQL schema and storage decisions there are normative. [plan.md](../plan.md) lists this phase as a checkbox; this file is the per-phase task doc the plan now points to. [phases/02-type-system.md](02-type-system.md) shipped the schemas this package will round-trip; we depend on `@ship/workflow` for every row → domain hydration.

## Summary

A single TypeScript package — `@ship/store` — that owns SQLite persistence for V1. Three normalized tables (`workflow_runs`, `phases`, `cursor_runs`) plus a tiny migration runner. A `Store` interface that other packages (`core`, eventually `cli` and `mcp-server` indirectly) consume; a default implementation built on `better-sqlite3` with hand-written SQL and `@ship/workflow`'s Zod schemas as the row → domain validation seam.

It exists for two reasons:

1. **Durable workflow state.** Per spec.md § "Non-functional requirements", restarting Ship between steps must not lose state. Every status transition is committed before the public method returns. The DB file is the source of truth for "what happened" after the agent's stream is gone from memory.
2. **Encapsulate the SQL layer.** No other Ship package writes SQL or knows what columns exist. `core` calls `store.getRun(id)` and gets a hydrated `WorkflowRun`. If we later swap SQLite for something else (we won't, but if), it's a one-package change.

This phase ships the package; subsequent phases (`core`, `cli`, `mcp-server`) consume it.

## Functional requirements

### F1 — Schema + migrations

The package owns the SQL schema in spec.md § "Data model — SQL schema", expressed as numbered SQL files under `packages/store/migrations/`:

```
packages/store/migrations/
  0001_init.sql           -- workflow_runs, phases, cursor_runs + their indices
```

A `runMigrations(db)` helper, called automatically by `createStore({ dbPath })` on first connect:

1. Creates the `_migrations` table if absent: `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`.
2. Reads the migrations directory in lexicographic order.
3. For each filename not in `_migrations.name`: opens a transaction, executes the SQL, inserts the row, commits.
4. Returns silently when caught up.

Idempotent: running twice is a no-op on the second run. Atomic per migration: a failure mid-statement rolls the transaction back, so a half-applied migration is impossible.

### F2 — `Store` interface

A factory function plus an interface:

```ts
export interface CreateStoreOptions {
  dbPath: string;          // absolute path; caller resolves <UserConfigDir>
}

export function createStore(opts: CreateStoreOptions): Store;

export interface Store {
  createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRun;
  updateWorkflowRunStatus(id: string, status: WorkflowStatus): WorkflowRun;
  appendPhase(input: AppendPhaseInput): Phase;
  updatePhase(id: string, patch: UpdatePhaseInput): Phase;
  recordCursorRun(input: RecordCursorRunInput): CursorRunRef;
  updateCursorRunStatus(id: string, patch: UpdateCursorRunInput): CursorRunRef;
  getRun(id: string): WorkflowRun | null;
  listRuns(filter: ListRunsFilter): WorkflowRun[];
  cancelRun(id: string): WorkflowRun;          // idempotent
  close(): void;
}
```

All methods are synchronous (better-sqlite3 is sync). All methods that mutate either commit before return or throw. Read methods return hydrated domain shapes (`getRun` resolves `phases: Phase[]` in one call).

The exact `*Input` shapes:

```ts
export interface CreateWorkflowRunInput {
  id: string;                  // wf_<ulid>; caller generates via @ship/workflow
  repo: string;
  docPath: string;
  baseRef: string;
  worktree: WorktreeRef;
  policy: WorkflowPolicy;
  // status defaults to "pending"; createdAt / updatedAt set to now()
}

export interface AppendPhaseInput {
  id: string;                  // ph_<ulid>
  workflowRunId: string;
  kind: PhaseKind;
  inputJson: string;
  // status defaults to "pending"
}

export interface UpdatePhaseInput {
  status?: PhaseStatus;
  startedAt?: string;
  endedAt?: string;
  cursorRunId?: string;
  outputJson?: string;
  errorMessage?: string;
}

export interface RecordCursorRunInput {
  id: string;                  // cr_<ulid>
  workflowRunId: string;
  agentId: string;
  runtime: CursorRunRuntime;
  model?: ModelSelection;
  artifactsDir: string;
  // status defaults to "running"; startedAt set to now()
}

export interface UpdateCursorRunInput {
  status?: CursorRunStatus;
  endedAt?: string;
  durationMs?: number;
}

export interface ListRunsFilter {
  repo?: string;
  status?: WorkflowStatus[];
  limit?: number;              // default 50, max 200
}
```

`cancelRun(id)` is idempotent:
- If the run is already terminal (`succeeded` / `failed` / `cancelled`), returns the current row without modification.
- If the run is `pending` / `running`, transitions to `cancelled`, sets `updated_at`, and (best-effort) marks any in-flight phase as `cancelled` too. Returns the updated row.

### F3 — Hydrated `WorkflowRun` from normalized tables

`getRun` and `listRuns` produce hydrated `WorkflowRun` shapes — the rows you read out match exactly what `@ship/workflow`'s `workflowRunSchema` validates. Implementation:

1. `SELECT ... FROM workflow_runs WHERE id = ?` → one row.
2. `SELECT ... FROM phases WHERE workflow_run_id = ? ORDER BY created_at ASC` → many rows.
3. Combine in code: `{ ...workflowRunRow, worktree: JSON.parse(...), policy: JSON.parse(...), phases: phaseRows.map(rowToPhase) }`.
4. Run the result through `workflowRunSchema.parse(...)` so column drift, JSON parse failures, or missing fields fail loud at the seam.

For `listRuns`: one query for the workflow runs (with WHERE / ORDER / LIMIT), then one query per returned id for its phases (V1 expected limit ≤ 200; up to 200 sub-queries is fine on a local SQLite). Optimization to a single JOIN can wait until we measure it.

### F4 — Cursor-run persistence (write-only in V1)

The `cursor_runs` table is written to (`recordCursorRun`, `updateCursorRunStatus`) but not surfaced via reads in V1. `Phase.cursorRunId` carries the FK; `getRun` does not currently hydrate `cursorRun` data into the domain shape because `WorkflowRun` doesn't contain `CursorRunRef[]`. If `core` or `mcp-server` later need to render cursor-run metadata, that's a follow-up read method (`getCursorRun(id)`) added then.

Persisting them in V1 is non-negotiable: failing a run must leave behind a queryable record of which agent ran it, when, with what model. Even without read methods, the row stays in the DB for after-the-fact inspection.

## Non-functional requirements

- **Zero side effects on import.** No log lines, no DB connection at module load. The connection opens on `createStore({ dbPath })`, not before. Importing `@ship/store` is free.
- **Synchronous API.** Matches `better-sqlite3`. No `Promise` wrapping; no fake-async hot-path.
- **Single-process, single-user.** No `BEGIN EXCLUSIVE` dance, no advisory locks. We document the assumption; cross-process coordination is V2 if it ever happens.
- **WAL mode + foreign keys ON.** Set on every connection. `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;` runs before the first query.
- **TypeScript strict + same lint bar as Phase 2.** No `any`. Inferred types from a small set of hand-written row interfaces; everything that crosses the package boundary uses `@ship/workflow` types.
- **No `@ship/mcp` dependency.** This package is internal-state-only; the MCP wire surface doesn't belong here.
- **Test coverage:** every method round-trips at least one entity; `listRuns` filtering covered exhaustively (each filter combination); migration runner covered (fresh DB + already-applied DB); `cancelRun` idempotency covered.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Storage stack | **`better-sqlite3` + raw SQL + Zod parse on hydration** | Drizzle (typed builder + migrations CLI), Kysely (typed builder, BYO migrations), Prisma (heavier, codegen) | Habib's Go background leans toward `sqlc`/raw drivers; an ORM hides SQL the team has to read anyway. The Zod schemas in `@ship/workflow` are already the source of truth for shape, so a second schema declaration in Drizzle creates two-things-to-keep-in-sync. The handful of V1 queries (~10) doesn't pay back the autocomplete a builder buys. Cost: no compile-time check that the column name in a SELECT matches the table; mitigated by round-trip tests + Zod parse on every read. |
| Migration format | **Numbered SQL files + tiny runner** | Drizzle Kit's diff-based migrations, a TS-DSL ("migration as TypeScript function") | SQL files are vendor-neutral, copy-pastable into any SQLite client, diffable in PR review without tooling, and avoid a second tool's lifecycle. Trade: no `migrate:revert`. V1 doesn't need it; if we ever do, a `down.sql` per up file is a 20-line addition. |
| Sync vs async API | **Sync** | `Promise`-wrapped methods | `better-sqlite3` is sync. Wrapping in `async` adds zero parallelism and forces every caller into `await`. `core` is the only consumer and can call sync just fine. Future async backends would be a different `Store` impl, behind the same interface. |
| Hydration strategy | **Two queries (workflow_runs, phases) + combine in code** | One JOIN with `json_group_array`, hand-mapped row builder | Two-query is simpler, easier to read, fast enough at V1 scale (≤200 rows × 1 phase each). JOIN-with-aggregate is a measure-then-optimize move. |
| Domain validation | **`workflowRunSchema.parse` on every hydration** | Trust the rows; only validate at the MCP boundary | Validating on hydration means schema drift fails loud the moment a column changes shape, not three hops downstream. The cost is ~one parse per query, which is fine for 50–200 rows; we re-litigate if profiling shows it's hot. |
| Module shape | **Single barrel `index.ts`** | Sub-path exports | Consistent with `@ship/workflow` and `@ship/mcp`. Tree-shakers handle dead code. |
| Source layout | **One file per logical group** (`migrations.ts`, `workflow-runs.ts`, `phases.ts`, `cursor-runs.ts`, `store.ts`, `db.ts`) | Single `store.ts` | Phases land at the per-table level naturally; co-locating the SQL strings with the TS that calls them keeps each file under 200 LOC. The `store.ts` factory is thin glue. |
| Test layout | **Co-located `*.test.ts`** | `test/` dir | Vitest's default; consistent with Phase 2. |
| WAL mode | **On** | Default rollback-journal | WAL is faster for the read-while-write pattern Ship has (the MCP server may `getRun` while a write is in-flight from `core`). Costs a `-wal` and `-shm` sidecar file; acceptable. |
| Foreign keys | **On** | Default off | SQLite ships with FKs *off* by default. Off means `phases.workflow_run_id` references can dangle silently. On is the only sane default for V1. |

## Engineering decisions

### ED-1 — Raw `better-sqlite3`, no ORM

Every query is a hand-written SQL string; rows return as plain objects (`Record<string, SqliteValue>`). A small per-table module owns its CRUD; `store.ts` composes the methods into the `Store` interface. JSON-blob columns (`worktree_json`, `policy_json`, `model_json`) are `JSON.parse`'d on read, validated by the Zod schema, and `JSON.stringify`'d on write.

### ED-2 — Migrations as numbered SQL files + a 30-line runner

`migrations/0001_init.sql` is the V1 schema verbatim. The runner applies-once-and-records in a `_migrations` table. No `down.sql` in V1; rollback is "drop the DB and re-create it during dev." When V2 adds a real migration, it's `0002_<thing>.sql` and the runner picks it up automatically.

### ED-3 — Zod parse on every row → domain hydration

`getRun` and `listRuns` build the hydrated `WorkflowRun` shape in code, then call `workflowRunSchema.parse(...)`. If a column was renamed, dropped, or re-typed without a schema bump, the parse throws and the test that exercises that path fails immediately. The cost is ~50µs per parse on a small object — orders of magnitude under the SQLite query cost it follows.

### ED-4 — Synchronous API, top to bottom

No `async`/`await` anywhere in the package. The interface is sync. Tests call the methods directly without `await`. If we ever swap in an async backend, that's a different `Store` implementation behind the same shape — cell-by-cell async wrapping happens at the implementation seam, not bled into the interface.

### ED-5 — `JSON.parse` JSON-blob columns once, treat them as opaque thereafter

Columns like `worktree_json`, `policy_json`, `model_json`, `phase.input_json`, `phase.output_json` are stored as `TEXT` and parsed on read. The first three get Zod-validated by the parent schema; the latter two stay opaque strings (per Phase 2 ED — `Phase.inputJson` is stringly-typed in V1).

### ED-6 — Prepared statements cached on store init

Every SQL string used at runtime is `db.prepare(sql)`'d once at `createStore` time and reused per call. `better-sqlite3` keeps the prepared statement around indefinitely; we just hold the references. Faster, and centralizes the "all the SQL this package runs" view to a single table at the top of each per-table module.

### ED-7 — `<UserConfigDir>` resolution lives in `core`, not here

`createStore({ dbPath })` accepts an absolute path injected by the caller. `core` is the package that does the `<UserConfigDir>/ship/state.db` resolution (matching spec.md ED-4). Keeping this package "give me a path" makes it trivial to test (point at `:memory:` or a temp file in tests) and keeps platform / config concerns out of the storage layer.

### ED-8 — `:memory:` is a first-class `dbPath`

Tests pass `dbPath: ":memory:"` and run the migrations on a fresh in-memory DB per test (or per suite, depending on perf). Production passes the real path. No special-cased "test mode."

## API boundaries / contracts

The public surface — everything re-exported by `packages/store/src/index.ts`. With `verbatimModuleSyntax: true`, type-only re-exports use `export type`:

```ts
// === store.ts ===
export { createStore } from "./store.js";
export type {
  Store,
  CreateStoreOptions,
  CreateWorkflowRunInput,
  AppendPhaseInput,
  UpdatePhaseInput,
  RecordCursorRunInput,
  UpdateCursorRunInput,
  ListRunsFilter,
} from "./store.js";
```

Nothing else is exported. The per-table modules (`workflow-runs.ts`, `phases.ts`, `cursor-runs.ts`), the migration runner, the prepared-statement cache — all internal.

### Error policy

Every method throws a typed Error subclass on failure:

- `WorkflowRunNotFoundError` — `getRun` and `listRuns` return null / empty for "not found"; mutators (`updateStatus`, `cancelRun`, `appendPhase`, `updatePhase`) throw if the parent doesn't exist.
- `PhaseNotFoundError` — `updatePhase` throws if the phase id doesn't resolve.
- `StoreSchemaError` — wraps a Zod parse failure on hydration. Message includes the offending field path.
- `MigrationError` — wraps a SQL failure during `runMigrations`.

These live in `packages/store/src/errors.ts` and are exported from the barrel.

### Stability promise (within V1)

The `Store` interface is the contract `core` codes against. Adding a method is fine; removing or changing a method's signature is a breaking change that updates `core` in the same commit. The migration set is append-only: once a migration is on `main`, it never gets edited. New migrations always get a higher number.

## Data model

Spec.md § "Data model — SQL schema" is canonical. The migration applies it verbatim:

```sql
CREATE TABLE workflow_runs (
  id          TEXT PRIMARY KEY,
  repo        TEXT NOT NULL,
  doc_path    TEXT NOT NULL,
  status      TEXT NOT NULL,
  base_ref    TEXT NOT NULL,
  worktree_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX workflow_runs_repo_idx   ON workflow_runs (repo);
CREATE INDEX workflow_runs_status_idx ON workflow_runs (status);
CREATE INDEX workflow_runs_created_at_idx ON workflow_runs (created_at DESC);

CREATE TABLE phases (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT,
  cursor_run_id   TEXT,
  input_json      TEXT NOT NULL,
  output_json     TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX phases_workflow_run_id_idx ON phases (workflow_run_id);

CREATE TABLE cursor_runs (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  runtime         TEXT NOT NULL,
  model_json      TEXT,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_ms     INTEGER,
  artifacts_dir   TEXT NOT NULL
);
CREATE INDEX cursor_runs_workflow_run_id_idx ON cursor_runs (workflow_run_id);
```

Refinements vs raw spec.md:

1. **Added `workflow_runs_created_at_idx`.** `listRuns` defaults to most-recent-first; without an index on `created_at`, every list scans the table. Cheap to add now.
2. **Empty `_migrations` table created by the runner**, not in `0001_init.sql`. Keeps the SQL file as "the actual schema" without bookkeeping bleed.

## Validation plan

Tests live in `packages/store/src/*.test.ts`, run by `vitest run`.

### Migrations

- ✅ Fresh `:memory:` DB: `runMigrations` creates `_migrations`, applies `0001_init.sql`, returns. Tables exist.
- ✅ Re-run on the same DB: no-op; `_migrations` still has one row.
- ✅ Adding a synthetic `0002_test.sql` (in a test fixture, not committed): runner applies it on top of an already-migrated DB.
- ❌ A migration that fails mid-statement: the txn rolls back; `_migrations` row is not inserted; subsequent run retries the failed migration.

### `createWorkflowRun` + `getRun` round-trip

- ✅ Create with a valid input → row appears with status `"pending"`, `createdAt == updatedAt`, `phases: []`.
- ✅ `getRun(id)` returns the hydrated `WorkflowRun`, validates against `workflowRunSchema`.
- ✅ Round-trip test: stash → fetch → deep-equal (modulo trivial ordering of `phases`).
- ❌ `getRun` of a non-existent id returns `null` (not throw).
- ❌ Re-creating with a duplicate id throws (PK violation).

### `updateWorkflowRunStatus` + `cancelRun`

- ✅ `pending → running → succeeded`: each transition updates the row and bumps `updated_at`.
- ✅ `cancelRun` of `running`: status becomes `cancelled`; `updated_at` bumps.
- ✅ `cancelRun` of `cancelled` (already-terminal): no-op; returns current row; idempotent.
- ✅ `cancelRun` of `pending`: status becomes `cancelled`.
- ❌ `cancelRun` of a non-existent id throws `WorkflowRunNotFoundError`.

### `appendPhase` + `updatePhase`

- ✅ Append a phase to an existing run; `getRun` shows it in `phases`.
- ✅ Update phase status / startedAt / endedAt → `getRun` reflects the changes.
- ❌ `appendPhase` for a non-existent workflow run id throws (FK violation).
- ❌ `updatePhase` of a non-existent phase throws `PhaseNotFoundError`.
- ✅ Multiple phases append in chronological order; `getRun` returns them sorted by `created_at`.

### `recordCursorRun` + `updateCursorRunStatus`

- ✅ Record + update; row exists in `cursor_runs`.
- ❌ FK violation on bad `workflowRunId`.
- (No read-out tests — V1 doesn't surface cursor runs through the store.)

### `listRuns`

- ✅ No filter: most-recent-first, capped at default limit (50).
- ✅ Filter by `repo`.
- ✅ Filter by `status: ["running", "pending"]`.
- ✅ Filter by both `repo` and `status`.
- ✅ Custom limit; over-max rejected.
- ✅ Empty result on no matches.
- ✅ Returned rows are fully hydrated (each has its own `phases`).

### Hydration error path

- ❌ Manually corrupt a `worktree_json` to malformed JSON → `getRun` throws `StoreSchemaError`.
- ❌ Manually delete a column value that should be present → `getRun` throws `StoreSchemaError` (Zod catches).

### Acceptance

- `pnpm --filter @ship/store test` exits 0.
- `pnpm typecheck` / `lint` / `format:check` from repo root pass.
- Coverage shows every Store method exercised, every migration path hit.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Native module install fails on a contributor machine | Workflow blocked | Root `pnpm.onlyBuiltDependencies` already allowlists `better-sqlite3`. CI verifies "no ignored build scripts." Doc the workaround in the README. |
| SQLite WAL files left behind on crash | `-wal` / `-shm` files clutter the runs dir | Standard SQLite behavior; `PRAGMA wal_checkpoint(TRUNCATE)` on `close()` cleans up. |
| Zod parse on every read becomes hot | Latency on `listRuns` with high limits | V1 limits to 200; profile if it ever shows up. Skipping the parse is a one-line escape hatch. |
| Column rename without migration | Silent corruption / parse failures at runtime | The Zod parse is the catch — drift fails loud, not silent. Plus a CI test that hydrates known fixtures. |
| Concurrent writes (multiple ShipService instances) | Lost updates | We document "single-process per `state.db`." better-sqlite3 serializes within a process via a mutex. Cross-process, SQLite's own locking takes over but caller would need to retry on `SQLITE_BUSY`; not in V1 because not in V1's threat model. |
| Forgetting to call `close()` in tests | Open file handles, slow test suite | Vitest `afterEach` hook, plus `:memory:` for most tests so the GC handles it. |
| `JSON.stringify` of a circular object getting persisted | Throws on write, but only when called wrong | Caller's bug, not ours; test paths use known-shape inputs. |

## Open questions

1. **Does `recordCursorRun` belong on the public `Store` interface in V1, or on a hidden `internal` interface?** Proposed: public. `core` calls it directly. No second interface.
2. **Where does the `dbPath` default come from?** Proposed: `core` resolves `<UserConfigDir>/ship/state.db` and passes it in. `store` doesn't depend on `node:os` / `node:path`.
3. **Should `listRuns` support pagination (offset / cursor) in V1?** Proposed: no. V1 returns the most-recent ≤ 200 runs. If we need pagination, add `before: createdAt` cursor when V2 actually has too many runs to fit.
4. **Do we expose `db: Database` directly for ad-hoc queries or migrations?** Proposed: no. Every query goes through a typed method. Adding more methods is the right escape hatch.
5. **Drizzle Kit-style snapshot tests of the schema?** Proposed: no. The migration SQL is human-readable; PR review reads it. We add a snapshot only if a contributor accidentally ships a schema change without updating the migration SQL.

## Implementation plan

After review/approval, implement in this order:

1. **`packages/store/{package.json, tsconfig.json, vitest.config.ts}`** — workspace wiring per Phase 2's pattern. Deps: `better-sqlite3`, `@ship/workflow` (`workspace:*`); devDeps: `@types/better-sqlite3`.
2. **`migrations/0001_init.sql`** — the schema verbatim from above.
3. **`src/db.ts`** — open + configure the connection (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`).
4. **`src/migrations.ts` + `migrations.test.ts`** — the runner; tests against a `:memory:` DB and a synthetic second migration.
5. **`src/errors.ts`** — `WorkflowRunNotFoundError`, `PhaseNotFoundError`, `StoreSchemaError`, `MigrationError`.
6. **`src/workflow-runs.ts` + `workflow-runs.test.ts`** — `createWorkflowRun`, `updateWorkflowRunStatus`, `getRun` (without phases yet), `listRuns` (without phases yet), `cancelRun`. Round-trip + filter tests.
7. **`src/phases.ts` + `phases.test.ts`** — `appendPhase`, `updatePhase`. Then wire `getRun` and `listRuns` to hydrate `phases` in `workflow-runs.ts` (cross-file collaboration; both files updated in this step).
8. **`src/cursor-runs.ts` + `cursor-runs.test.ts`** — `recordCursorRun`, `updateCursorRunStatus`. Write-only.
9. **`src/store.ts`** — `createStore` factory; composes the per-table modules into the `Store` interface; runs migrations on init.
10. **`src/index.ts`** — barrel.
11. **`pnpm install`** + **`make check`** from repo root — must be green. Specifically:
    - `pnpm typecheck` passes.
    - `pnpm lint` passes.
    - `pnpm format:check` passes.
    - `pnpm test` shows `@ship/store`'s tests passing.
    - `pnpm --filter @ship/store test` exits 0.
12. **Mark Phase 3 done in [plan.md](../plan.md).**

Total LOC estimate: ~600 source + ~700 tests. Wall time: 3–5h (more state to round-trip than Phase 2; SQLite specifics worth getting right the first time).

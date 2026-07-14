# Store convergence — CLI resolvers honor `SHIP_DB_PATH` / `SHIP_RUNS_DIR` exactly like the MCP server

**Status**: implemented
**Owner**: @itsHabib
**Date**: 2026-07-13
**Related**: dossier task `ccp-store-convergence` (`tsk_01KWHFYSDXDSJWZ10Q4ZAS3GG7`, project `ship`); CCP spec [`docs/features/cloud-control-plane/spec.md`](../spec.md) §4 D5, §9 Phase 2 (synthesis C7).

## Scope

| Bucket | Files | Weighted |
|---|---|---|
| Production source | `packages/cli/src/service.ts` (`resolveDbPath` / `resolveRunsDir` read env first, `isAbsolute()`-guarded), `packages/mcp-server/src/store-paths.ts` (resolvers extracted from `bin.ts` so they are unit-testable; same guard), `packages/mcp-server/src/bin.ts` (now pure wiring) | 100 |
| Tests | resolver parity matrix — env set / unset / relative / absolute × CLI / mcp-server | 70 |
| Docs | this phase doc (the one-time operator merge procedure) | 0 |
| **Total** | | **~170** |

Band: **amazing** (< 500). Single PR — one resolution shape mirrored across two surfaces.

## Functional

A connector dispatch (MCP server) and a terminal `ship` (CLI) on ONE machine must resolve the SAME store. The MCP server already read `SHIP_DB_PATH` / `SHIP_RUNS_DIR`; the CLI's `resolveDbPath` / `resolveRunsDir` did not read env at all. Under the packaged-app split, the connector's default resolved into the app-virtualized data dir while the terminal resolved the real profile dir — two seats on one machine, two stores, orphaning each other's history. That breaks the TDD's seat-portability premise (D5) before any cloud work begins.

- **F1** — CLI `resolveDbPath` / `resolveRunsDir` read `SHIP_DB_PATH` / `SHIP_RUNS_DIR` first, honored only when `isAbsolute()`, else the `<UserConfigDir>/ship/{state.db, runs/}` default.
- **F2** — MCP server applies the identical `isAbsolute()` guard (it previously accepted a relative env value verbatim — the ship#18 P3 parity gap).
- **F3** — Same env → identical resolved paths on both surfaces; relative / empty values rejected identically on both.

## Tradeoffs

- **Two copies, not one shared module.** The CLI and MCP server deliberately do NOT import each other (`test/dep-direction.test.ts` on both packages); both sit on `@ship/core`. `userConfigDir` was already duplicated on purpose for exactly this reason. We keep that shape: `packages/mcp-server/src/store-paths.ts` re-derives the resolution rather than importing `@ship/cli`. The L1 parity matrix is what keeps the two copies honest — it imports both and asserts byte-identical output across the env grid.
- **Resolvers extracted from `bin.ts`.** `bin.ts` runs `main()` at import, so its inline resolution was untestable without booting stdio (and `bin.ts` is excluded from mcp-server coverage). Moving the resolvers into `store-paths.ts` makes them unit-testable and keeps `bin.ts` as pure wiring.

## EDs (engineering decisions)

- **ED-1** — `envStoreOverride` returns `undefined` (not the default path) on a miss, so the `?? default` at the call site is the single place the default is spelled. Empty string is treated as unset, matching the existing `XDG_CONFIG_HOME` handling.
- **ED-2** — Parity test lives under `packages/mcp-server/test/` (not `src/`) precisely so it can import `@ship/cli/src/service.js`; the dep-direction guard scans `src/**` only. `@ship/cli` is a mcp-server **devDependency** (test-only), mirroring the existing `@ship/test-harness` → core exception.
- **ED-3** — Import the CLI resolvers by their `src/service.js` subpath, never the package main (`@ship/cli` → `src/bin.ts`, whose top-level `main()` boots the CLI).

## Validation

- `make check` green (typecheck + lint + format + per-package coverage gate).
- L1 parity matrix: `(env set-absolute | unset | empty | relative) × (dbPath | runsDir) × (CLI | mcp-server)` + the posix/win32 default-fallback branches, asserting identical resolved paths and identical rejection.

## Risks

- e2e scenarios and the L3 integration test set `SHIP_DB_PATH` / `SHIP_RUNS_DIR` to absolute paths (`mkdtemp` / `live.root`), so the new `isAbsolute()` guard does not regress them. A hypothetical caller that relied on a *relative* env value would now silently fall back to the default — that is the intended fix, not a regression.

## Out-of-scope (non-goals)

- Any new CLI verb (no `ship converge`) — the merge below is documentation, not a subcommand.
- Store schema changes.
- Multi-machine store sync (D5 — GitHub is the cross-seat rendezvous).

## Implementation plan

1. CLI `resolveDbPath` / `resolveRunsDir` read env first via an `isAbsolute()`-guarded `envStoreOverride` helper.
2. Extract the mcp-server resolvers into `store-paths.ts` with the same guard; `bin.ts` consumes them.
3. L1 parity matrix under `packages/mcp-server/test/`, plus CLI-side env-override cases in `service.test.ts`.
4. This doc: the one-time operator merge procedure.

---

## One-time operator merge (documentation, NOT a verb)

After this fix, both surfaces resolve the same store going forward. Any rows already stranded in the app-container store (written while the connector resolved the virtualized data dir) must be merged **once** into the real-profile store. This is an operator runbook step, deliberately **not** a `ship converge` subcommand — no premature doctor verbs.

### Preconditions

- Stop every ship process (the MCP server / connector, any `ship` / `ship driver` run). The store is seat-local SQLite in WAL mode; merging into a live DB risks lock contention.
- Identify the two DB files:
  - **REAL** — the canonical store the CLI now resolves: `<UserConfigDir>/ship/state.db` (or your absolute `SHIP_DB_PATH`).
  - **CONTAINER** — the app-virtualized copy the connector wrote before this fix (e.g. under the packaged app's sandbox data dir).
- Back up the REAL store first: `cp state.db state.db.bak` (and the `-wal` / `-shm` sidecars if present).

### Merge

`INSERT OR IGNORE` is the whole trick: every table is keyed by a ULID primary key (plus a few `UNIQUE` constraints), so re-inserting a row that already exists is a no-op and only genuinely-missing rows land. Insert in **foreign-key-dependency order** (parents before children) with `foreign_keys = ON` so no child outlives its parent.

```sql
-- Run against the REAL store. CONTAINER is the app-container copy.
-- sqlite3 /path/to/REAL/state.db
PRAGMA foreign_keys = ON;
ATTACH DATABASE '/path/to/CONTAINER/state.db' AS container;

BEGIN;

-- Parents first.
INSERT OR IGNORE INTO workflow_runs SELECT * FROM container.workflow_runs;
INSERT OR IGNORE INTO driver_runs    SELECT * FROM container.driver_runs;

-- Children of workflow_runs / driver_runs.
INSERT OR IGNORE INTO phases         SELECT * FROM container.phases;
INSERT OR IGNORE INTO cursor_runs    SELECT * FROM container.cursor_runs;
INSERT OR IGNORE INTO driver_batches SELECT * FROM container.driver_batches;

-- Children of driver_batches / driver_runs.
INSERT OR IGNORE INTO driver_streams SELECT * FROM container.driver_streams;

-- Children of driver_streams / driver_runs.
INSERT OR IGNORE INTO escalations             SELECT * FROM container.escalations;
INSERT OR IGNORE INTO driver_review_artifacts SELECT * FROM container.driver_review_artifacts;

COMMIT;
DETACH DATABASE container;
```

Notes:

- **Run artifacts** (`<runs-dir>/<runId>/`) live on disk, not in SQLite. If the container also split `SHIP_RUNS_DIR`, copy its run dirs into the real runs dir the same idempotent way: `cp -rn CONTAINER_RUNS/. REAL_RUNS/` (`-n` = no-clobber, so an existing run dir is never overwritten).
- **Schema drift.** Both stores must be at the same migration head before merging (`SELECT MAX(id) FROM _migrations;` — the runner's bookkeeping table, created outside the migration files). If the container is behind, open it with any current ship build once to run migrations forward, then merge. Do NOT copy `_migrations` rows between DBs.
- The partial unique index on open `escalations` (`escalations_open_dedup_idx`) means a duplicate *open* escalation for the same (run, stream, class) is dropped by `INSERT OR IGNORE` — the desired behavior.

### Verify

After merge, dispatch a run via the connector (MCP server) and confirm it is visible from the terminal CLI (`ship list` / `ship driver list`), and vice versa. Both now resolve one store, so each seat sees the other's history. (This verification is manual — not automated; the automated coverage is the L1 resolver-parity matrix.)

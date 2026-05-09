/**
 * `createStore` factory + the public `Store` interface.
 *
 * This file is the only one outside `index.ts` whose exports are public.
 * Consumers (`core`, eventually `cli` and `mcp-server`) construct a
 * `Store` with `createStore({ dbPath })` and never see the per-table ops
 * or the `Db` handle.
 *
 * `createStore` is the single seam that:
 *   1. Opens the `better-sqlite3` connection and applies the standard
 *      PRAGMA setup (`db.ts`).
 *   2. Runs migrations synchronously via `runMigrations` (`migrations.ts`).
 *      The store is unusable until migrations are caught up; there is no
 *      "open without migrating" mode in V1.
 *   3. Constructs the three per-table ops modules in dependency order
 *      (phases first, since workflow-runs depends on phases for hydration
 *      and cancel coordination).
 *   4. Wires the per-table methods into a single `Store` object.
 *
 * `close()` runs `PRAGMA wal_checkpoint(TRUNCATE)` before closing the
 * connection so the `-wal` / `-shm` sidecars don't accumulate. The
 * caller is responsible for not invoking other `Store` methods
 * concurrently with `close()` — the store does not internally serialize.
 */

import type { CursorRunRef, Phase, WorkflowRun, WorkflowStatus } from "@ship/workflow";

import type { RecordCursorRunInput, UpdateCursorRunInput } from "./cursor-runs.js";
import type { AppendPhaseInput, UpdatePhaseInput } from "./phases.js";
import type { CreateWorkflowRunInput, ListRunsFilter } from "./workflow-runs.js";

import { createCursorRunOps } from "./cursor-runs.js";
import { openDatabase } from "./db.js";
import { runMigrations } from "./migrations.js";
import { createPhaseOps } from "./phases.js";
import { createWorkflowRunOps } from "./workflow-runs.js";

/**
 * Construction-time options for `createStore`.
 *
 * - `dbPath` — absolute filesystem path; caller resolves
 *              `<UserConfigDir>/ship/state.db` (per spec.md ED-4).
 *              `":memory:"` is a first-class value used by tests
 *              (per phases/03-store.md ED-8).
 * - `clock`  — optional ISO-8601 string source. Defaults to
 *              `() => new Date().toISOString()`. `core` injects a fake
 *              clock in tests so `created_at` / artifact paths are
 *              deterministic.
 */
export interface CreateStoreOptions {
  dbPath: string;
  clock?: () => string;
}

/**
 * The public surface of `@ship/store`.
 *
 * Every method is synchronous (matching `better-sqlite3`); read methods
 * return hydrated `@ship/workflow` domain shapes; mutators commit before
 * returning or throw. See per-method JSDoc on each input type for the
 * exact contract.
 */
export interface Store {
  /**
   * Insert a workflow run with `status = 'pending'`. The caller passes
   * a `wf_<ulid>` id (from `@ship/workflow`'s `newWorkflowRunId`) and
   * the immutable run-creation fields. Returns the hydrated row with
   * `phases: []`.
   */
  createWorkflowRun: (input: CreateWorkflowRunInput) => WorkflowRun;
  /**
   * Flip a workflow run's `status` and bump `updated_at`. Throws
   * `WorkflowRunNotFoundError` if `id` is unknown.
   *
   * **Does not check the state machine.** `core` is the canonical
   * state-machine owner and calls `canTransition(current, next)` from
   * `@ship/workflow` before invoking this method. The store will happily
   * flip `succeeded` to `pending`; if `core` ever requests an invalid
   * transition, that's a `core` bug.
   */
  updateWorkflowRunStatus: (id: string, status: WorkflowStatus) => WorkflowRun;
  /**
   * Insert a phase belonging to `workflowRunId` with `status = 'pending'`.
   * Bumps the parent run's `updated_at` in the same transaction. Throws
   * `WorkflowRunNotFoundError` if the parent doesn't exist (the FK
   * violation is translated).
   */
  appendPhase: (input: AppendPhaseInput) => Phase;
  /**
   * Patch any subset of a phase's mutable columns. Bumps the parent run's
   * `updated_at` in the same transaction. Throws `PhaseNotFoundError` if
   * the phase id doesn't resolve.
   */
  updatePhase: (id: string, patch: UpdatePhaseInput) => Phase;
  /**
   * Insert a cursor run with `status = 'running'` and `startedAt = clock()`.
   * Throws `WorkflowRunNotFoundError` if `workflowRunId` doesn't exist
   * (the FK violation is translated).
   */
  recordCursorRun: (input: RecordCursorRunInput) => CursorRunRef;
  /**
   * Patch any subset of a cursor run's mutable columns. Throws if the
   * id is unknown. The empty patch is a no-op that returns the current
   * row.
   */
  updateCursorRunStatus: (id: string, patch: UpdateCursorRunInput) => CursorRunRef;
  /**
   * Hydrated cursor run, or `null` if the id is unknown. Does not throw.
   */
  getCursorRun: (id: string) => CursorRunRef | null;
  /**
   * Hydrated workflow run plus its phases, or `null` if the id is
   * unknown. Does not throw.
   */
  getRun: (id: string) => WorkflowRun | null;
  /**
   * Filtered + ordered + limited list of workflow runs. Default limit
   * is 50; the maximum accepted is 200. Always exactly two queries
   * regardless of N (rows + grouped phases).
   */
  listRuns: (filter: ListRunsFilter) => WorkflowRun[];
  /**
   * Idempotent cancel.
   *
   * - If the run is already terminal (`succeeded` / `failed` /
   *   `cancelled`), returns the current row without modification (no
   *   transaction).
   * - Otherwise, opens one transaction that flips the run's `status` to
   *   `cancelled` and any `pending` / `running` phase belonging to the
   *   run to `cancelled` with `endedAt = clock()`. Either both commit
   *   or neither does.
   *
   * Throws `WorkflowRunNotFoundError` if the id is unknown.
   */
  cancelRun: (id: string) => WorkflowRun;
  /**
   * Run `PRAGMA wal_checkpoint(TRUNCATE)` (so the `-wal` / `-shm`
   * sidecars are cleaned up) and close the underlying SQLite handle.
   *
   * Caller is responsible for not invoking other `Store` methods
   * concurrently with `close()`. The store does not abort in-flight
   * prepared statements.
   */
  close: () => void;
}

/**
 * Default clock used when `createStore` isn't given one.
 *
 * Returns ISO-8601 with offset (`Z` for UTC) so every persisted
 * timestamp is round-trippable through `@ship/workflow`'s
 * `z.string().datetime({ offset: true })` validation.
 */
function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * Construct a `Store`. Opens the SQLite connection at `opts.dbPath`,
 * applies the standard PRAGMA setup, runs migrations synchronously,
 * and wires the per-table modules together.
 *
 * Synchronous; matches the rest of `@ship/store`. Throws if migrations
 * fail (`MigrationError`) or if `better-sqlite3` cannot open the path.
 * After this returns, the store is fully usable until `close()`.
 *
 * On any failure during init (migrations, prepared-statement compile,
 * etc.) the open SQLite handle is closed before re-throwing — otherwise
 * a long-lived caller (the daemon path, future retry loops) would
 * accumulate open file handles and leak SQLite locks.
 */
export function createStore(opts: CreateStoreOptions): Store {
  const clock = opts.clock ?? defaultClock;
  const db = openDatabase(opts.dbPath);
  try {
    runMigrations(db, { clock });

    const phaseOps = createPhaseOps(db, clock);
    const workflowRunOps = createWorkflowRunOps(db, clock, phaseOps);
    const cursorRunOps = createCursorRunOps(db, clock);

    return {
      appendPhase: phaseOps.append,
      cancelRun: workflowRunOps.cancel,
      close: () => {
        // wal_checkpoint(TRUNCATE) cleans up the -wal / -shm sidecars on
        // a happy shutdown. It can throw SQLITE_BUSY when another
        // connection is mid-write — in that case we still need
        // db.close() to run, otherwise the SQLite handle and any file
        // locks leak. The checkpoint failure is non-fatal for shutdown.
        try {
          db.pragma("wal_checkpoint(TRUNCATE)");
        } finally {
          db.close();
        }
      },
      createWorkflowRun: workflowRunOps.create,
      getCursorRun: cursorRunOps.get,
      getRun: workflowRunOps.get,
      listRuns: workflowRunOps.list,
      recordCursorRun: cursorRunOps.record,
      updateCursorRunStatus: cursorRunOps.updateStatus,
      updatePhase: phaseOps.update,
      updateWorkflowRunStatus: workflowRunOps.updateStatus,
    };
  } catch (err: unknown) {
    db.close();
    throw err;
  }
}

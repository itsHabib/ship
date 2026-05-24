/**
 * `createStore` factory and the public `Store` interface. Opens the SQLite
 * connection, applies PRAGMAs, runs migrations, and wires the per-table ops
 * modules into a single `Store`.
 */

import type { CursorRunRef, Phase, WorkflowRun, WorkflowStatus } from "@ship/workflow";

import type {
  RecordCursorRunInput,
  ResumableCloudCursorRun,
  UpdateCursorRunInput,
} from "./cursor-runs.js";
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
 * - `dbPath` — absolute filesystem path. `:memory:` is a first-class value
 *   used by tests (per phases/03-store.md ED-8).
 * - `clock`  — optional ISO-8601 source; defaults to
 *   `() => new Date().toISOString()`. Tests inject a fake clock for
 *   deterministic timestamps.
 */
export interface CreateStoreOptions {
  dbPath: string;
  clock?: () => string;
}

/**
 * The public surface of `@ship/store`. Every method is synchronous (matching
 * `better-sqlite3`); reads return hydrated `@ship/workflow` domain shapes;
 * mutators commit before returning or throw.
 */
export interface Store {
  /**
   * Insert a workflow run with `status = 'pending'`. Caller passes a
   * `wf_<ulid>` id from `@ship/workflow`'s `newWorkflowRunId`. Returns the
   * hydrated row with `phases: []`.
   */
  createWorkflowRun: (input: CreateWorkflowRunInput) => WorkflowRun;
  /**
   * Flip a workflow run's `status` and bump `updated_at`. Throws
   * `WorkflowRunNotFoundError` if `id` is unknown. Does NOT check the state
   * machine — `core` enforces transitions via `canTransition` before
   * invoking.
   */
  updateWorkflowRunStatus: (id: string, status: WorkflowStatus) => WorkflowRun;
  /**
   * Atomic `pending → running` transition for both the workflow row and a
   * specific phase row, wrapped in a single SQLite transaction. Throws
   * `WorkflowRunNotFoundError` / `PhaseNotFoundError` on missing rows; the
   * txn rolls back so neither side mutates on the failure path. Used by
   * `ShipService`'s kickoff to keep the two writes from leaving the run
   * stranded at `phase=running, workflow=pending`.
   */
  markRunStarted: (workflowRunId: string, phaseId: string, startedAt: string) => void;
  /**
   * Insert a phase with `status = 'pending'`; bumps the parent run's
   * `updated_at` in the same transaction. Throws `WorkflowRunNotFoundError`
   * if the parent doesn't exist (FK violation translated).
   */
  appendPhase: (input: AppendPhaseInput) => Phase;
  /**
   * Patch any subset of a phase's mutable columns; bumps the parent run's
   * `updated_at` in the same transaction. Throws `PhaseNotFoundError` if
   * unknown.
   */
  updatePhase: (id: string, patch: UpdatePhaseInput) => Phase;
  /**
   * Insert a cursor run with `status = 'running'` and `startedAt = clock()`.
   * Throws `WorkflowRunNotFoundError` if `workflowRunId` doesn't exist (FK
   * violation translated).
   */
  recordCursorRun: (input: RecordCursorRunInput) => CursorRunRef;
  /**
   * Patch any subset of a cursor run's mutable columns. Throws if unknown.
   * Empty patch is a no-op that returns the current row.
   */
  updateCursorRunStatus: (id: string, patch: UpdateCursorRunInput) => CursorRunRef;
  /** Hydrated cursor run, or `null` if unknown. Does not throw. */
  getCursorRun: (id: string) => CursorRunRef | null;
  /**
   * Cloud cursor runs eligible for startup resume (`running`/`pending` with
   * a persisted SDK `run_id`).
   */
  listResumableCloudCursorRuns: () => ResumableCloudCursorRun[];
  /** Bump `workflow_runs.updated_at` without changing status. */
  touchWorkflowRunUpdatedAt: (workflowRunId: string) => void;
  /** Hydrated workflow run plus phases, or `null` if unknown. Does not throw. */
  getRun: (id: string) => WorkflowRun | null;
  /**
   * Filtered + ordered + limited list of workflow runs. Default limit 50,
   * max 200. Always exactly two queries regardless of N (rows + grouped
   * phases).
   */
  listRuns: (filter: ListRunsFilter) => WorkflowRun[];
  /**
   * Idempotent cancel. Already-terminal runs return unchanged. Otherwise one
   * transaction flips the run to `cancelled` and any `pending` / `running`
   * phase under it to `cancelled` with `endedAt = clock()`. Throws
   * `WorkflowRunNotFoundError` if unknown.
   */
  cancelRun: (id: string) => WorkflowRun;
  /**
   * Run `PRAGMA wal_checkpoint(TRUNCATE)` (cleans up `-wal` / `-shm`
   * sidecars) and close the SQLite handle. Caller must not invoke other
   * `Store` methods concurrently with `close()`.
   */
  close: () => void;
}

/**
 * Default clock. Returns ISO-8601 with offset so persisted timestamps
 * round-trip through `@ship/workflow`'s `z.string().datetime({ offset: true })`.
 */
function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * Construct a `Store`. Opens the SQLite connection, applies PRAGMAs, runs
 * migrations, wires the per-table ops modules. Throws `MigrationError` on
 * migration failure. On any init failure the handle is closed before
 * re-throwing.
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
        // wal_checkpoint(TRUNCATE) can throw SQLITE_BUSY under contention;
        // that's non-fatal for shutdown (SQLite reclaims sidecars on the
        // next clean run), so warn and still close.
        try {
          db.pragma("wal_checkpoint(TRUNCATE)");
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(
            `[@ship/store] wal_checkpoint(TRUNCATE) failed during close(); the -wal/-shm sidecars may persist until the next clean shutdown: ${reason}`,
          );
        }
        db.close();
      },
      createWorkflowRun: workflowRunOps.create,
      getCursorRun: cursorRunOps.get,
      getRun: workflowRunOps.get,
      listResumableCloudCursorRuns: cursorRunOps.listResumableCloud,
      listRuns: workflowRunOps.list,
      markRunStarted: workflowRunOps.markRunStarted,
      recordCursorRun: cursorRunOps.record,
      touchWorkflowRunUpdatedAt: workflowRunOps.touchUpdatedAt,
      updateCursorRunStatus: cursorRunOps.updateStatus,
      updatePhase: phaseOps.update,
      updateWorkflowRunStatus: workflowRunOps.updateStatus,
    };
  } catch (err: unknown) {
    db.close();
    throw err;
  }
}

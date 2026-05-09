/**
 * Per-table module for `cursor_runs`.
 *
 * Owns every SQL string that touches the `cursor_runs` table. Three
 * methods exposed to `store.ts`:
 * - `record`       — INSERT a fresh row with `status = 'running'`.
 *                    Translates `SQLITE_CONSTRAINT_FOREIGNKEY` into
 *                    `WorkflowRunNotFoundError` so callers don't have
 *                    to know about SQLite error codes.
 * - `updateStatus` — patch any subset of `{status, endedAt, durationMs}`.
 *                    The empty patch is a no-op (returns the current
 *                    row); a non-existent id throws.
 * - `get`          — point-read. Returns `null` for unknown ids
 *                    (matching `getRun`'s semantics for `workflow_runs`).
 *
 * Cursor runs are persisted as a separate table — not eagerly hydrated
 * into `WorkflowRun` — because `Phase.cursorRunId` is the FK and
 * `WorkflowRun` itself doesn't carry a `cursorRun` field in V1. Callers
 * that need cursor-run metadata for a phase fetch it explicitly via
 * `getCursorRun(phase.cursorRunId)`. See phases/03-store.md § F4.
 *
 * Hydration uses `cursorRunRefSchema.parse` at the seam, same pattern as
 * the other two tables. Optional columns are conditionally assigned to
 * the candidate object so `exactOptionalPropertyTypes` is happy.
 */

import type {
  CursorRunRef,
  CursorRunRuntime,
  CursorRunStatus,
  ModelSelection,
} from "@ship/workflow";

import { cursorRunRefSchema } from "@ship/workflow";

import type { Db } from "./db.js";

import { StoreSchemaError, WorkflowRunNotFoundError } from "./errors.js";

/**
 * Inputs accepted by `recordCursorRun`.
 *
 * `status` defaults to `"running"` and `startedAt` to `clock()`; both
 * are not part of the input. `model` is optional because the SDK leaves
 * it undefined on resume per the documented gotcha (see
 * `cursorRunRefSchema` in `@ship/workflow`).
 */
export interface RecordCursorRunInput {
  id: string;
  workflowRunId: string;
  agentId: string;
  runtime: CursorRunRuntime;
  model?: ModelSelection;
  artifactsDir: string;
}

/**
 * Patch shape for `updateCursorRunStatus`.
 *
 * Every field is optional — the caller only sends what it wants to
 * change. Typical pattern: a runner receives the SDK's terminal event
 * and calls with `{ status: "succeeded", endedAt: now, durationMs: dt }`.
 */
export interface UpdateCursorRunInput {
  status?: CursorRunStatus;
  endedAt?: string;
  durationMs?: number;
}

/**
 * The internal cursor-run-table API consumed by `store.ts`.
 *
 * Not re-exported from the package barrel; only the public `Store`
 * interface in `store.ts` is.
 */
export interface CursorRunOps {
  /** Insert a cursor run with `status = 'running'`; throws if `workflowRunId` is unknown. */
  record: (input: RecordCursorRunInput) => CursorRunRef;
  /** Patch the named columns; throws if the id is unknown. */
  updateStatus: (id: string, patch: UpdateCursorRunInput) => CursorRunRef;
  /** Hydrated row, or `null` if the id is unknown (does not throw). */
  get: (id: string) => CursorRunRef | null;
}

/** Internal: shape of one row returned by every `SELECT * FROM cursor_runs`. */
interface CursorRunRow {
  id: string;
  workflow_run_id: string;
  agent_id: string;
  runtime: string;
  model_json: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  artifacts_dir: string;
}

/** Column list shared by every `SELECT` against `cursor_runs`. */
const CURSOR_RUN_COLUMNS =
  "id, workflow_run_id, agent_id, runtime, model_json, status, started_at, ended_at, duration_ms, artifacts_dir";

/**
 * Constructs the `cursor_runs` ops bound to a given DB connection and
 * clock. Caches every static prepared statement at construction time
 * per ED-6. The dynamic-SET update builds SQL on the fly because the
 * SET shape varies per call.
 */
export function createCursorRunOps(db: Db, clock: () => string): CursorRunOps {
  const insertStmt = db.prepare(
    `INSERT INTO cursor_runs (id, workflow_run_id, agent_id, runtime, model_json, status, started_at, artifacts_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectByIdStmt = db.prepare<[string], CursorRunRow>(
    `SELECT ${CURSOR_RUN_COLUMNS} FROM cursor_runs WHERE id = ?`,
  );

  function record(input: RecordCursorRunInput): CursorRunRef {
    try {
      insertStmt.run(
        input.id,
        input.workflowRunId,
        input.agentId,
        input.runtime,
        input.model !== undefined ? JSON.stringify(input.model) : null,
        "running",
        clock(),
        input.artifactsDir,
      );
    } catch (err: unknown) {
      if (isForeignKeyViolation(err)) {
        throw new WorkflowRunNotFoundError(input.workflowRunId);
      }
      throw err;
    }
    const row = selectByIdStmt.get(input.id);
    if (!row) {
      throw new Error(`internal: just-inserted cursor run ${input.id} not found`);
    }
    return parseCursorRun(row);
  }

  function updateStatus(id: string, patch: UpdateCursorRunInput): CursorRunRef {
    if (!hasAnyPatchField(patch)) {
      const current = selectByIdStmt.get(id);
      if (!current) {
        throw new Error(`cursor run not found: ${id}`);
      }
      return parseCursorRun(current);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.endedAt !== undefined) {
      sets.push("ended_at = ?");
      params.push(patch.endedAt);
    }
    if (patch.durationMs !== undefined) {
      sets.push("duration_ms = ?");
      params.push(patch.durationMs);
    }
    params.push(id);
    const result = db
      .prepare(`UPDATE cursor_runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    if (result.changes === 0) {
      throw new Error(`cursor run not found: ${id}`);
    }
    const updated = selectByIdStmt.get(id);
    if (!updated) {
      throw new Error(`internal: cursor run ${id} vanished after update`);
    }
    return parseCursorRun(updated);
  }

  function get(id: string): CursorRunRef | null {
    const row = selectByIdStmt.get(id);
    return row ? parseCursorRun(row) : null;
  }

  return { get, record, updateStatus };
}

/**
 * Returns true when at least one field of an `UpdateCursorRunInput`
 * patch is set. Lets the empty-patch path skip the dynamic-SET SQL
 * altogether.
 */
function hasAnyPatchField(patch: UpdateCursorRunInput): boolean {
  return (
    patch.status !== undefined || patch.endedAt !== undefined || patch.durationMs !== undefined
  );
}

/**
 * Builds a `CursorRunRef` candidate from a row and runs
 * `cursorRunRefSchema.parse`.
 *
 * `model_json` is parsed back to a `ModelSelection`; failed
 * `JSON.parse` is wrapped as `StoreSchemaError` for uniform handling
 * with Zod-parse failures. Optional columns are conditionally assigned
 * so `exactOptionalPropertyTypes` is happy.
 *
 * Note: `workflow_run_id` is NOT part of `CursorRunRef` (it's the FK,
 * not surface), so the candidate omits it.
 */
function parseCursorRun(row: CursorRunRow): CursorRunRef {
  let model: unknown;
  if (row.model_json !== null) {
    try {
      model = JSON.parse(row.model_json);
    } catch (err: unknown) {
      throw new StoreSchemaError(`cursor_runs id=${row.id} has malformed model_json column`, {
        cause: err,
      });
    }
  }
  const candidate: {
    id: string;
    agentId: string;
    runtime: string;
    startedAt: string;
    status: string;
    artifactsDir: string;
    model?: unknown;
    endedAt?: string;
    durationMs?: number;
  } = {
    agentId: row.agent_id,
    artifactsDir: row.artifacts_dir,
    id: row.id,
    runtime: row.runtime,
    startedAt: row.started_at,
    status: row.status,
  };
  if (model !== undefined) candidate.model = model;
  if (row.ended_at !== null) candidate.endedAt = row.ended_at;
  if (row.duration_ms !== null) candidate.durationMs = row.duration_ms;

  const result = cursorRunRefSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoreSchemaError(
      `cursor_runs id=${row.id} failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * Detects `SQLITE_CONSTRAINT_FOREIGNKEY` errors from `better-sqlite3`.
 * Same shape as `phases.ts`'s detector; duplicated rather than shared
 * because the per-table modules deliberately don't import each other
 * for non-SQL helpers.
 */
function isForeignKeyViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (err as Error & { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

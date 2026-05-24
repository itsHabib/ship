/**
 * Per-table module for `cursor_runs`. Owns every SQL string that touches
 * the table; hydrates rows via `cursorRunRefSchema`.
 */

import type {
  CursorRunRef,
  CursorRunRuntime,
  CursorRunStatus,
  ModelSelection,
} from "@ship/workflow";

import { cursorRunRefSchema } from "@ship/workflow";

import type { Db } from "./db.js";

import { CursorRunNotFoundError, StoreSchemaError, WorkflowRunNotFoundError } from "./errors.js";

/**
 * Inputs for `recordCursorRun`. `model` is optional because the SDK
 * leaves it undefined on resume.
 */
export interface RecordCursorRunInput {
  id: string;
  workflowRunId: string;
  agentId: string;
  /** SDK run id (`run-<uuid>`). Required for cloud resume. */
  runId?: string;
  runtime: CursorRunRuntime;
  model?: ModelSelection;
  artifactsDir: string;
}

/** Patch shape for `updateCursorRunStatus`; every field optional. */
export interface UpdateCursorRunInput {
  status?: CursorRunStatus;
  endedAt?: string;
  durationMs?: number;
}

/** Row shape consumed by `ShipService.resumeOrphanedRuns`. */
export interface ResumableCloudCursorRun {
  readonly id: string;
  readonly workflowRunId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly model?: ModelSelection;
  readonly artifactsDir: string;
}

/** Internal cursor-run-table API consumed by `store.ts`. */
export interface CursorRunOps {
  /** Insert a cursor run with `status = 'running'`; throws if `workflowRunId` is unknown. */
  record: (input: RecordCursorRunInput) => CursorRunRef;
  /** Patch the named columns; throws if the id is unknown. */
  updateStatus: (id: string, patch: UpdateCursorRunInput) => CursorRunRef;
  /** Hydrated row, or `null` if the id is unknown (does not throw). */
  get: (id: string) => CursorRunRef | null;
  /**
   * Cloud rows eligible for startup resume: `status IN ('running','pending')`,
   * `runtime = 'cloud'`, and a persisted SDK `run_id`.
   */
  listResumableCloud: () => ResumableCloudCursorRun[];
}

interface CursorRunRow {
  id: string;
  workflow_run_id: string;
  agent_id: string;
  run_id: string | null;
  runtime: string;
  model_json: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  artifacts_dir: string;
}

const CURSOR_RUN_COLUMNS =
  "id, workflow_run_id, agent_id, run_id, runtime, model_json, status, started_at, ended_at, duration_ms, artifacts_dir";

/**
 * Constructs the `cursor_runs` ops. Caches static prepared statements
 * (ED-6); the dynamic-SET update builds SQL per call.
 */
export function createCursorRunOps(db: Db, clock: () => string): CursorRunOps {
  const insertStmt = db.prepare(
    `INSERT INTO cursor_runs (id, workflow_run_id, agent_id, run_id, runtime, model_json, status, started_at, artifacts_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectByIdStmt = db.prepare<[string], CursorRunRow>(
    `SELECT ${CURSOR_RUN_COLUMNS} FROM cursor_runs WHERE id = ?`,
  );
  const listResumableCloudStmt = db.prepare<[], CursorRunRow>(
    `SELECT ${CURSOR_RUN_COLUMNS} FROM cursor_runs
     WHERE runtime = 'cloud'
       AND status IN ('running', 'pending')
       AND run_id IS NOT NULL`,
  );

  function record(input: RecordCursorRunInput): CursorRunRef {
    // Wrap insert + hydration in one txn so a Zod failure rolls back the write.
    const txn = db.transaction((): CursorRunRef => {
      try {
        insertStmt.run(
          input.id,
          input.workflowRunId,
          input.agentId,
          input.runId ?? null,
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
    });
    return txn();
  }

  function updateStatus(id: string, patch: UpdateCursorRunInput): CursorRunRef {
    if (!hasAnyPatchField(patch)) {
      const current = selectByIdStmt.get(id);
      if (!current) {
        throw new CursorRunNotFoundError(id);
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
    // Wrap update + hydration in one txn so a post-state that fails Zod
    // (e.g. negative durationMs) rolls back rather than committing a row
    // future reads will reject.
    const txn = db.transaction((): CursorRunRef => {
      const result = db
        .prepare(`UPDATE cursor_runs SET ${sets.join(", ")} WHERE id = ?`)
        .run(...params);
      if (result.changes === 0) {
        throw new CursorRunNotFoundError(id);
      }
      const updated = selectByIdStmt.get(id);
      if (!updated) {
        throw new Error(`internal: cursor run ${id} vanished after update`);
      }
      return parseCursorRun(updated);
    });
    return txn();
  }

  function get(id: string): CursorRunRef | null {
    const row = selectByIdStmt.get(id);
    return row ? parseCursorRun(row) : null;
  }

  function listResumableCloud(): ResumableCloudCursorRun[] {
    return listResumableCloudStmt.all().flatMap((row) => {
      if (row.run_id === null || row.run_id === "") return [];
      let model: ModelSelection | undefined;
      if (row.model_json !== null) {
        try {
          model = JSON.parse(row.model_json) as ModelSelection;
        } catch {
          // Malformed model_json — keep the row resumable. The caller
          // (ShipService.resumeOrphanedRuns) falls back to its
          // configured `defaultModel`, so filtering the row out here
          // would prevent recovery of an otherwise-valid orphan over a
          // soft data issue. Treat model as undefined and proceed.
          model = undefined;
        }
      }
      return [
        {
          agentId: row.agent_id,
          artifactsDir: row.artifacts_dir,
          id: row.id,
          ...(model !== undefined && { model }),
          runId: row.run_id,
          workflowRunId: row.workflow_run_id,
        },
      ];
    });
  }

  return { get, listResumableCloud, record, updateStatus };
}

/** True when at least one field of the patch is set. */
function hasAnyPatchField(patch: UpdateCursorRunInput): boolean {
  return (
    patch.status !== undefined || patch.endedAt !== undefined || patch.durationMs !== undefined
  );
}

/**
 * Builds a `CursorRunRef` candidate and runs `cursorRunRefSchema.parse`.
 * Failed `JSON.parse` of `model_json` is wrapped as `StoreSchemaError`.
 * `workflow_run_id` is the FK and is not part of the surface shape.
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

/** Detects `SQLITE_CONSTRAINT_FOREIGNKEY` errors from `better-sqlite3`. */
function isForeignKeyViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (err as Error & { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

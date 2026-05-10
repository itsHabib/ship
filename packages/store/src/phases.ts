/**
 * Per-table module for `phases`. Owns every SQL string that touches the
 * table, plus the `workflow_runs.updated_at` bump every phase mutation
 * triggers.
 */

import type { Phase, PhaseKind, PhaseStatus } from "@ship/workflow";

import { phaseSchema } from "@ship/workflow";

import type { Db } from "./db.js";

import { PhaseNotFoundError, StoreSchemaError, WorkflowRunNotFoundError } from "./errors.js";

/**
 * Inputs for `appendPhase`. `inputJson` is a non-empty string per
 * `phaseSchema`; status defaults to `"pending"`.
 */
export interface AppendPhaseInput {
  id: string;
  workflowRunId: string;
  kind: PhaseKind;
  inputJson: string;
}

/**
 * Patch shape for `updatePhase`. Empty patch is a no-op for the phase
 * row itself but still bumps the parent run's `updated_at`.
 */
export interface UpdatePhaseInput {
  status?: PhaseStatus;
  startedAt?: string;
  endedAt?: string;
  cursorRunId?: string;
  outputJson?: string;
  errorMessage?: string;
}

/** Internal phase-table API consumed by `workflow-runs.ts` and `store.ts`. */
export interface PhaseOps {
  /** Insert a phase with `status = 'pending'`; bumps the parent run's `updated_at`. */
  append: (input: AppendPhaseInput) => Phase;
  /** Patch the named columns; bumps the parent run's `updated_at`. */
  update: (id: string, patch: UpdatePhaseInput) => Phase;
  /** All phases for a single run, ordered chronologically. */
  listByRunId: (runId: string) => Phase[];
  /** All phases for many runs in one query, grouped by run id. */
  listByRunIds: (runIds: readonly string[]) => Map<string, Phase[]>;
  /** Cancel any in-flight phases under `runId`. Must run inside the caller's transaction. */
  cancelInFlightForRun: (runId: string, endedAt: string) => void;
}

interface PhaseRow {
  id: string;
  workflow_run_id: string;
  kind: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  cursor_run_id: string | null;
  input_json: string;
  output_json: string | null;
  error_message: string | null;
  created_at: string;
}

const PHASE_COLUMNS =
  "id, workflow_run_id, kind, status, started_at, ended_at, cursor_run_id, input_json, output_json, error_message, created_at";

/**
 * Constructs the `phases` ops. Caches static prepared statements (ED-6);
 * the dynamic-SET update and dynamic-IN list build SQL per call.
 */
export function createPhaseOps(db: Db, clock: () => string): PhaseOps {
  const insertStmt = db.prepare(
    `INSERT INTO phases (id, workflow_run_id, kind, status, input_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectByIdStmt = db.prepare<[string], PhaseRow>(
    `SELECT ${PHASE_COLUMNS} FROM phases WHERE id = ?`,
  );
  const selectByRunIdStmt = db.prepare<[string], PhaseRow>(
    `SELECT ${PHASE_COLUMNS} FROM phases WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC`,
  );
  const cancelInFlightStmt = db.prepare(
    `UPDATE phases SET status = 'cancelled', ended_at = ?
       WHERE workflow_run_id = ? AND status IN ('pending', 'running')`,
  );
  const bumpRunUpdatedAtStmt = db.prepare(`UPDATE workflow_runs SET updated_at = ? WHERE id = ?`);

  function append(input: AppendPhaseInput): Phase {
    // Insert + parent bump + hydrate in one txn so a Zod failure rolls back.
    const txn = db.transaction((): Phase => {
      const now = clock();
      try {
        insertStmt.run(input.id, input.workflowRunId, input.kind, "pending", input.inputJson, now);
      } catch (err: unknown) {
        if (isForeignKeyViolation(err)) {
          throw new WorkflowRunNotFoundError(input.workflowRunId);
        }
        throw err;
      }
      bumpRunUpdatedAtStmt.run(now, input.workflowRunId);
      const row = selectByIdStmt.get(input.id);
      if (!row) {
        throw new Error(`internal: just-inserted phase ${input.id} not found`);
      }
      return parsePhase(row);
    });
    return txn();
  }

  function update(id: string, patch: UpdatePhaseInput): Phase {
    // Patch + parent bump + hydrate in one txn so a Zod failure rolls back.
    const txn = db.transaction((): Phase => {
      const existing = selectByIdStmt.get(id);
      if (!existing) {
        throw new PhaseNotFoundError(id);
      }
      applyPhasePatch(db, id, patch);
      bumpRunUpdatedAtStmt.run(clock(), existing.workflow_run_id);
      const updated = selectByIdStmt.get(id);
      if (!updated) {
        throw new Error(`internal: phase ${id} vanished after update`);
      }
      return parsePhase(updated);
    });
    return txn();
  }

  function listByRunId(runId: string): Phase[] {
    return selectByRunIdStmt.all(runId).map(parsePhase);
  }

  function listByRunIds(runIds: readonly string[]): Map<string, Phase[]> {
    const out = new Map<string, Phase[]>();
    if (runIds.length === 0) return out;
    const placeholders = runIds.map(() => "?").join(", ");
    const sql = `SELECT ${PHASE_COLUMNS} FROM phases WHERE workflow_run_id IN (${placeholders})
                 ORDER BY workflow_run_id, created_at ASC, id ASC`;
    const rows = db.prepare<unknown[], PhaseRow>(sql).all(...runIds);
    for (const row of rows) {
      const phase = parsePhase(row);
      const existing = out.get(row.workflow_run_id);
      if (existing) existing.push(phase);
      else out.set(row.workflow_run_id, [phase]);
    }
    return out;
  }

  function cancelInFlightForRun(runId: string, endedAt: string): void {
    cancelInFlightStmt.run(endedAt, runId);
  }

  return { append, cancelInFlightForRun, listByRunId, listByRunIds, update };
}

/**
 * Applies an `UpdatePhaseInput` patch as a dynamic UPDATE. Empty patch
 * is a SQL no-op; the parent-run `updated_at` bump still fires outside.
 */
function applyPhasePatch(db: Db, id: string, patch: UpdatePhaseInput): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.startedAt !== undefined) {
    sets.push("started_at = ?");
    params.push(patch.startedAt);
  }
  if (patch.endedAt !== undefined) {
    sets.push("ended_at = ?");
    params.push(patch.endedAt);
  }
  if (patch.cursorRunId !== undefined) {
    sets.push("cursor_run_id = ?");
    params.push(patch.cursorRunId);
  }
  if (patch.outputJson !== undefined) {
    sets.push("output_json = ?");
    params.push(patch.outputJson);
  }
  if (patch.errorMessage !== undefined) {
    sets.push("error_message = ?");
    params.push(patch.errorMessage);
  }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE phases SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

/**
 * Builds a `Phase` candidate and runs `phaseSchema.parse`. Optional
 * columns are conditionally assigned (schema uses `.optional()`, not
 * `.nullable()`). On parse failure throws `StoreSchemaError` with the
 * underlying `ZodError` as `cause`.
 */
function parsePhase(row: PhaseRow): Phase {
  const candidate: {
    id: string;
    workflowRunId: string;
    kind: string;
    status: string;
    inputJson: string;
    startedAt?: string;
    endedAt?: string;
    cursorRunId?: string;
    outputJson?: string;
    errorMessage?: string;
  } = {
    id: row.id,
    inputJson: row.input_json,
    kind: row.kind,
    status: row.status,
    workflowRunId: row.workflow_run_id,
  };
  if (row.started_at !== null) candidate.startedAt = row.started_at;
  if (row.ended_at !== null) candidate.endedAt = row.ended_at;
  if (row.cursor_run_id !== null) candidate.cursorRunId = row.cursor_run_id;
  if (row.output_json !== null) candidate.outputJson = row.output_json;
  if (row.error_message !== null) candidate.errorMessage = row.error_message;

  const result = phaseSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoreSchemaError(
      `phase id=${row.id} failed schema validation: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}

/** Detects `SQLITE_CONSTRAINT_FOREIGNKEY` via the driver's `code` property. */
function isForeignKeyViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (err as Error & { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

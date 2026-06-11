/**
 * Per-table module for `driver_batches`. Owns every SQL string that touches
 * the table, plus the parent `driver_runs.updated_at` bump on mutations.
 */

import type { Db } from "./db.js";
import type { DriverBatch, DriverBatchStatus } from "./driver-schemas.js";

import { driverBatchSchema } from "./driver-schemas.js";
import { DriverBatchNotFoundError, StoreSchemaError } from "./errors.js";

/** Patch shape for `updateDriverBatch`. */
export interface UpdateDriverBatchInput {
  status?: DriverBatchStatus;
  completedAt?: string;
}

/** Stream row hydrated elsewhere — batch hydration attaches streams after load. */
export interface DriverBatchRow {
  id: string;
  driver_run_id: string;
  batch_index: number;
  label: string | null;
  depends_on: string;
  status: string;
  completed_at: string | null;
}

/** Internal batch-table API consumed by `driver-runs.ts`. */
export interface DriverBatchOps {
  /** Insert a batch row (caller runs inside aggregate txn). */
  insert: (
    runId: string,
    input: {
      id: string;
      batchIndex: number;
      label?: string;
      dependsOn: number[];
      status: DriverBatchStatus;
      completedAt?: string;
    },
  ) => void;
  /** Patch progress columns; bumps parent run `updated_at`. */
  update: (id: string, patch: UpdateDriverBatchInput) => void;
  /** All batches for a run, ordered by `batch_index`. */
  listByRunId: (runId: string) => DriverBatchRow[];
  /** Parse a batch row + attached streams into a domain `DriverBatch`. */
  hydrate: (row: DriverBatchRow, streams: DriverBatch["streams"]) => DriverBatch;
}

const BATCH_COLUMNS = "id, driver_run_id, batch_index, label, depends_on, status, completed_at";

/**
 * Constructs the `driver_batches` ops. Caches static prepared statements;
 * dynamic-SET update builds SQL per call.
 */
export function createDriverBatchOps(
  db: Db,
  clock: () => string,
  bumpRunUpdatedAt: (runId: string) => void,
): DriverBatchOps {
  const insertStmt = db.prepare(
    `INSERT INTO driver_batches (id, driver_run_id, batch_index, label, depends_on, status, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectByIdStmt = db.prepare<[string], DriverBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM driver_batches WHERE id = ?`,
  );
  const selectByRunIdStmt = db.prepare<[string], DriverBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM driver_batches WHERE driver_run_id = ? ORDER BY batch_index ASC, id ASC`,
  );

  function insert(
    runId: string,
    input: {
      id: string;
      batchIndex: number;
      label?: string;
      dependsOn: number[];
      status: DriverBatchStatus;
      completedAt?: string;
    },
  ): void {
    insertStmt.run(
      input.id,
      runId,
      input.batchIndex,
      input.label ?? null,
      JSON.stringify(input.dependsOn),
      input.status,
      input.completedAt ?? null,
    );
  }

  function update(id: string, patch: UpdateDriverBatchInput): void {
    const txn = db.transaction((): void => {
      const existing = selectByIdStmt.get(id);
      if (!existing) {
        throw new DriverBatchNotFoundError(id);
      }
      applyBatchPatch(db, id, patch);
      bumpRunUpdatedAt(existing.driver_run_id);
    });
    txn();
  }

  function listByRunId(runId: string): DriverBatchRow[] {
    return selectByRunIdStmt.all(runId);
  }

  function hydrate(row: DriverBatchRow, streams: DriverBatch["streams"]): DriverBatch {
    return parseBatch(row, streams);
  }

  return { hydrate, insert, listByRunId, update };
}

function applyBatchPatch(db: Db, id: string, patch: UpdateDriverBatchInput): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.completedAt !== undefined) {
    sets.push("completed_at = ?");
    params.push(patch.completedAt);
  }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE driver_batches SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

function parseBatch(row: DriverBatchRow, streams: DriverBatch["streams"]): DriverBatch {
  let dependsOn: unknown;
  try {
    dependsOn = JSON.parse(row.depends_on);
  } catch (err: unknown) {
    throw new StoreSchemaError(`driver_batches id=${row.id} has malformed depends_on JSON`, {
      cause: err,
    });
  }
  const candidate: {
    batchIndex: number;
    completedAt?: string;
    dependsOn: unknown;
    driverRunId: string;
    id: string;
    label?: string;
    status: string;
    streams: DriverBatch["streams"];
  } = {
    batchIndex: row.batch_index,
    dependsOn,
    driverRunId: row.driver_run_id,
    id: row.id,
    status: row.status,
    streams,
  };
  if (row.label !== null) candidate.label = row.label;
  if (row.completed_at !== null) candidate.completedAt = row.completed_at;

  const result = driverBatchSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoreSchemaError(
      `driver_batches id=${row.id} failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export { parseBatch };

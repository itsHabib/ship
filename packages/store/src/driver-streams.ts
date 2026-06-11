/**
 * Per-table module for `driver_streams`. Owns every SQL string that touches
 * the table, plus the parent `driver_runs.updated_at` bump on mutations.
 */

import type { Db } from "./db.js";
import type { DriverStream, DriverStreamStatus, StreamAttempt } from "./driver-schemas.js";

import { driverStreamSchema } from "./driver-schemas.js";
import { DriverStreamNotFoundError, StoreSchemaError } from "./errors.js";

/** Patch shape for `updateDriverStream`. */
export interface UpdateDriverStreamInput {
  status?: DriverStreamStatus;
  workflowRunId?: string;
  attempts?: StreamAttempt[];
  prNumber?: number;
  prUrl?: string;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
  errorMessage?: string;
}

export interface DriverStreamRow {
  id: string;
  driver_run_id: string;
  driver_batch_id: string;
  task_id: string | null;
  task_slug: string | null;
  spec_path: string;
  branch: string | null;
  runtime: string;
  touches: string;
  status: string;
  workflow_run_id: string | null;
  attempts: string;
  pr_number: number | null;
  pr_url: string | null;
  merge_commit: string | null;
  merged_at: string | null;
  cycles: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface InsertStreamRowInput {
  id: string;
  taskId?: string;
  taskSlug?: string;
  specPath: string;
  branch?: string;
  runtime: string;
  touches: string[];
  status: DriverStreamStatus;
  workflowRunId?: string;
  attempts: StreamAttempt[];
  prNumber?: number;
  prUrl?: string;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
  errorMessage?: string;
  createdAt: string;
}

/** Internal stream-table API consumed by `driver-runs.ts`. */
export interface DriverStreamOps {
  /** Insert a stream row (caller runs inside aggregate txn). */
  insert: (runId: string, batchId: string, input: InsertStreamRowInput) => void;
  /** Patch progress columns; bumps parent run `updated_at`. */
  update: (id: string, patch: UpdateDriverStreamInput) => DriverStream;
  /** All streams for a run, ordered by `created_at, id`. */
  listByRunId: (runId: string) => DriverStreamRow[];
  /** Parse a stream row into a domain `DriverStream`. */
  parseRow: (row: DriverStreamRow) => DriverStream;
}

const STREAM_COLUMNS =
  "id, driver_run_id, driver_batch_id, task_id, task_slug, spec_path, branch, runtime, touches, status, workflow_run_id, attempts, pr_number, pr_url, merge_commit, merged_at, cycles, error_message, created_at, updated_at";

function sqlNull<T>(value: T | undefined): T | null {
  return value ?? null;
}

/**
 * Constructs the `driver_streams` ops. Caches static prepared statements;
 * dynamic-SET update builds SQL per call.
 */
export function createDriverStreamOps(
  db: Db,
  clock: () => string,
  bumpRunUpdatedAt: (runId: string) => void,
): DriverStreamOps {
  const insertStmt = db.prepare(
    `INSERT INTO driver_streams (
       id, driver_run_id, driver_batch_id, task_id, task_slug, spec_path, branch,
       runtime, touches, status, workflow_run_id, attempts, pr_number, pr_url,
       merge_commit, merged_at, cycles, error_message, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectByIdStmt = db.prepare<[string], DriverStreamRow>(
    `SELECT ${STREAM_COLUMNS} FROM driver_streams WHERE id = ?`,
  );
  const selectByRunIdStmt = db.prepare<[string], DriverStreamRow>(
    `SELECT ${STREAM_COLUMNS} FROM driver_streams WHERE driver_run_id = ?
     ORDER BY created_at ASC, id ASC`,
  );

  function insert(runId: string, batchId: string, input: InsertStreamRowInput): void {
    const now = clock();
    insertStmt.run(
      input.id,
      runId,
      batchId,
      sqlNull(input.taskId),
      sqlNull(input.taskSlug),
      input.specPath,
      sqlNull(input.branch),
      input.runtime,
      JSON.stringify(input.touches),
      input.status,
      sqlNull(input.workflowRunId),
      JSON.stringify(input.attempts),
      sqlNull(input.prNumber),
      sqlNull(input.prUrl),
      sqlNull(input.mergeCommit),
      sqlNull(input.mergedAt),
      sqlNull(input.cycles),
      sqlNull(input.errorMessage),
      input.createdAt,
      now,
    );
  }

  function update(id: string, patch: UpdateDriverStreamInput): DriverStream {
    const txn = db.transaction((): DriverStream => {
      const existing = selectByIdStmt.get(id);
      if (!existing) {
        throw new DriverStreamNotFoundError(id);
      }
      applyStreamPatch(db, id, patch, clock());
      bumpRunUpdatedAt(existing.driver_run_id);
      const updated = selectByIdStmt.get(id);
      if (!updated) {
        throw new Error(`internal: driver stream ${id} vanished after update`);
      }
      return parseStreamRow(updated);
    });
    return txn();
  }

  function listByRunId(runId: string): DriverStreamRow[] {
    return selectByRunIdStmt.all(runId);
  }

  return { insert, listByRunId, parseRow: parseStreamRow, update };
}

function applyStreamPatch(db: Db, id: string, patch: UpdateDriverStreamInput, now: string): void {
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];
  appendStreamPatchColumn(sets, params, "status = ?", patch.status);
  appendStreamPatchColumn(sets, params, "workflow_run_id = ?", patch.workflowRunId);
  appendStreamPatchColumn(sets, params, "attempts = ?", patch.attempts, JSON.stringify);
  appendStreamPatchColumn(sets, params, "pr_number = ?", patch.prNumber);
  appendStreamPatchColumn(sets, params, "pr_url = ?", patch.prUrl);
  appendStreamPatchColumn(sets, params, "merge_commit = ?", patch.mergeCommit);
  appendStreamPatchColumn(sets, params, "merged_at = ?", patch.mergedAt);
  appendStreamPatchColumn(sets, params, "cycles = ?", patch.cycles);
  appendStreamPatchColumn(sets, params, "error_message = ?", patch.errorMessage);
  if (sets.length === 1) return;
  params.push(id);
  db.prepare(`UPDATE driver_streams SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

function appendStreamPatchColumn<T>(
  sets: string[],
  params: unknown[],
  sql: string,
  value: T | undefined,
  map: (value: T) => unknown = (current) => current,
): void {
  if (value === undefined) return;
  sets.push(sql);
  params.push(map(value));
}

function parseStreamRow(row: DriverStreamRow): DriverStream {
  let touches: unknown;
  let attempts: unknown;
  try {
    touches = JSON.parse(row.touches);
    attempts = JSON.parse(row.attempts);
  } catch (err: unknown) {
    throw new StoreSchemaError(`driver_streams id=${row.id} has malformed JSON column`, {
      cause: err,
    });
  }
  const candidate = {
    attempts,
    createdAt: row.created_at,
    driverBatchId: row.driver_batch_id,
    driverRunId: row.driver_run_id,
    id: row.id,
    runtime: row.runtime,
    specPath: row.spec_path,
    status: row.status,
    touches,
    updatedAt: row.updated_at,
    ...optionalStreamFields(row),
  };

  const result = driverStreamSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoreSchemaError(
      `driver_streams id=${row.id} failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

function optionalStreamFields(row: DriverStreamRow): Record<string, string | number> {
  const entries: [string, string | number | null][] = [
    ["branch", row.branch],
    ["cycles", row.cycles],
    ["errorMessage", row.error_message],
    ["mergeCommit", row.merge_commit],
    ["mergedAt", row.merged_at],
    ["prNumber", row.pr_number],
    ["prUrl", row.pr_url],
    ["taskId", row.task_id],
    ["taskSlug", row.task_slug],
    ["workflowRunId", row.workflow_run_id],
  ];
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string | number] => entry[1] !== null),
  );
}

export { parseStreamRow };

/**
 * Per-table module for `driver_runs`. Owns SQL for the run row plus aggregate
 * hydration (run + batches + streams) and list/insert orchestration.
 */

import type { Db } from "./db.js";
import type { UpdateDriverBatchInput } from "./driver-batches.js";
import type { DriverBatch, DriverRun, DriverRunStatus, DriverStream } from "./driver-schemas.js";
import type { UpdateDriverStreamInput } from "./driver-streams.js";

import { createDriverBatchOps } from "./driver-batches.js";
import { driverRunSchema } from "./driver-schemas.js";
import { createDriverStreamOps } from "./driver-streams.js";
import { DriverBatchNotFoundError, DriverRunNotFoundError, StoreSchemaError } from "./errors.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Nested stream input for aggregate insert. */
export interface InsertDriverStreamInput {
  id: string;
  streamIndex: number;
  taskId?: string;
  taskSlug?: string;
  specPath: string;
  branch?: string;
  runtime: string;
  touches: string[];
  status: DriverStream["status"];
  workflowRunId?: string;
  attempts: DriverStream["attempts"];
  prNumber?: number;
  prUrl?: string;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
  errorMessage?: string;
}

/** Nested batch input for aggregate insert. */
export interface InsertDriverBatchInput {
  id: string;
  batchIndex: number;
  label?: string;
  dependsOn: number[];
  status: DriverBatch["status"];
  completedAt?: string;
  streams: InsertDriverStreamInput[];
}

/** Inputs for `insertDriverRun`. Caller supplies ids; timestamps come from clock. */
export interface InsertDriverRunInput {
  id: string;
  manifestPath: string;
  repo: string;
  project?: string;
  phase?: string;
  status: DriverRunStatus;
  sourceJson: string;
  batches: InsertDriverBatchInput[];
}

/** Filter for `listDriverRuns`. */
export interface ListDriverRunsFilter {
  repo?: string;
  project?: string;
  phase?: string;
  status?: DriverRunStatus[];
  limit?: number;
}

/** Internal driver-run-table API consumed by `store.ts`. */
export interface DriverRunOps {
  insert: (input: InsertDriverRunInput) => DriverRun;
  get: (id: string) => DriverRun | null;
  list: (filter: ListDriverRunsFilter) => DriverRun[];
  updateStatus: (id: string, status: DriverRunStatus) => DriverRun;
  stampTickStarted: (id: string) => DriverRun;
  stampTickEnded: (id: string) => DriverRun;
  updateBatch: (id: string, patch: UpdateDriverBatchInput) => DriverBatch;
  updateStream: (id: string, patch: UpdateDriverStreamInput) => DriverStream;
}

interface DriverRunRow {
  id: string;
  manifest_path: string;
  repo: string;
  project: string | null;
  phase: string | null;
  status: string;
  source_json: string;
  created_at: string;
  updated_at: string;
  tick_started_at: string | null;
  tick_ended_at: string | null;
}

const RUN_COLUMNS =
  "id, manifest_path, repo, project, phase, status, source_json, created_at, updated_at, tick_started_at, tick_ended_at";

/**
 * Constructs the `driver_runs` ops. Wires batch + stream modules for
 * aggregate hydration and insert.
 */
export function createDriverRunOps(db: Db, clock: () => string): DriverRunOps {
  const bumpUpdatedAtStmt = db.prepare(`UPDATE driver_runs SET updated_at = ? WHERE id = ?`);

  function bumpRunUpdatedAt(runId: string): void {
    bumpUpdatedAtStmt.run(clock(), runId);
  }

  const batches = createDriverBatchOps(db, clock, bumpRunUpdatedAt);
  const streams = createDriverStreamOps(db, clock, bumpRunUpdatedAt);

  const insertRunStmt = db.prepare(
    `INSERT INTO driver_runs (
       id, manifest_path, repo, project, phase, status, source_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectByIdStmt = db.prepare<[string], DriverRunRow>(
    `SELECT ${RUN_COLUMNS} FROM driver_runs WHERE id = ?`,
  );
  const updateStatusStmt = db.prepare(
    `UPDATE driver_runs SET status = ?, updated_at = ? WHERE id = ?`,
  );
  const stampTickStartedStmt = db.prepare(
    `UPDATE driver_runs SET tick_started_at = ?, updated_at = ? WHERE id = ?`,
  );
  const stampTickEndedStmt = db.prepare(
    `UPDATE driver_runs SET tick_ended_at = ?, updated_at = ? WHERE id = ?`,
  );
  const selectBatchRunIdStmt = db.prepare<[string], { driver_run_id: string }>(
    "SELECT driver_run_id FROM driver_batches WHERE id = ?",
  );

  function insert(input: InsertDriverRunInput): DriverRun {
    const txn = db.transaction((): DriverRun => {
      const now = clock();
      insertRunStmt.run(
        input.id,
        input.manifestPath,
        input.repo,
        input.project ?? null,
        input.phase ?? null,
        input.status,
        input.sourceJson,
        now,
        now,
      );
      for (const batch of input.batches) {
        const batchInsert: Parameters<typeof batches.insert>[1] = {
          batchIndex: batch.batchIndex,
          dependsOn: batch.dependsOn,
          id: batch.id,
          status: batch.status,
        };
        if (batch.completedAt !== undefined) batchInsert.completedAt = batch.completedAt;
        if (batch.label !== undefined) batchInsert.label = batch.label;
        batches.insert(input.id, batchInsert);
        for (const stream of batch.streams) {
          streams.insert(input.id, batch.id, {
            ...stream,
            createdAt: now,
          });
        }
      }
      const row = selectByIdStmt.get(input.id);
      if (!row) {
        throw new Error(`internal: just-inserted driver run ${input.id} not found`);
      }
      return hydrateRun(row, batches, streams);
    });
    return txn();
  }

  function get(id: string): DriverRun | null {
    const row = selectByIdStmt.get(id);
    return row ? hydrateRun(row, batches, streams) : null;
  }

  function list(filter: ListDriverRunsFilter): DriverRun[] {
    const limit = clampLimit(filter.limit);
    const { params, sql } = buildListSql(filter, limit);
    const rows = db.prepare<unknown[], DriverRunRow>(sql).all(...params);
    return rows.map((row) => hydrateRun(row, batches, streams));
  }

  function updateStatus(id: string, status: DriverRunStatus): DriverRun {
    const txn = db.transaction((): DriverRun => {
      const result = updateStatusStmt.run(status, clock(), id);
      if (result.changes === 0) {
        throw new DriverRunNotFoundError(id);
      }
      const row = selectByIdStmt.get(id);
      if (!row) {
        throw new Error(`internal: driver run ${id} vanished after status update`);
      }
      return hydrateRun(row, batches, streams);
    });
    return txn();
  }

  function stampTickStarted(id: string): DriverRun {
    const txn = db.transaction((): DriverRun => {
      const now = clock();
      const result = stampTickStartedStmt.run(now, now, id);
      if (result.changes === 0) {
        throw new DriverRunNotFoundError(id);
      }
      const row = selectByIdStmt.get(id);
      if (!row) {
        throw new Error(`internal: driver run ${id} vanished after tick start stamp`);
      }
      return hydrateRun(row, batches, streams);
    });
    return txn();
  }

  function stampTickEnded(id: string): DriverRun {
    const txn = db.transaction((): DriverRun => {
      const now = clock();
      const result = stampTickEndedStmt.run(now, now, id);
      if (result.changes === 0) {
        throw new DriverRunNotFoundError(id);
      }
      const row = selectByIdStmt.get(id);
      if (!row) {
        throw new Error(`internal: driver run ${id} vanished after tick end stamp`);
      }
      return hydrateRun(row, batches, streams);
    });
    return txn();
  }

  function updateBatch(id: string, patch: UpdateDriverBatchInput): DriverBatch {
    // Write + hydrate in one txn so a hydration StoreSchemaError rolls the
    // write back, matching the sibling mutators.
    const txn = db.transaction((): DriverBatch => {
      batches.update(id, patch);
      const parent = selectBatchRunIdStmt.get(id);
      if (!parent) {
        throw new DriverBatchNotFoundError(id);
      }
      return getBatchWithStreams(parent.driver_run_id, id, batches, streams);
    });
    return txn();
  }

  function updateStream(id: string, patch: UpdateDriverStreamInput): DriverStream {
    return streams.update(id, patch);
  }

  return {
    get,
    insert,
    list,
    stampTickEnded,
    stampTickStarted,
    updateBatch,
    updateStatus,
    updateStream,
  };
}

function hydrateRun(
  row: DriverRunRow,
  batches: ReturnType<typeof createDriverBatchOps>,
  streams: ReturnType<typeof createDriverStreamOps>,
): DriverRun {
  const batchRows = batches.listByRunId(row.id);
  const streamRows = streams.listByRunId(row.id);
  const streamsByBatch = groupStreamsByBatch(streamRows, streams);

  const hydratedBatches = batchRows.map((batchRow) =>
    batches.hydrate(batchRow, streamsByBatch.get(batchRow.id) ?? []),
  );

  const candidate: {
    batches: DriverBatch[];
    createdAt: string;
    id: string;
    manifestPath: string;
    phase?: string;
    project?: string;
    repo: string;
    sourceJson: string;
    status: string;
    tickEndedAt?: string;
    tickStartedAt?: string;
    updatedAt: string;
  } = {
    batches: hydratedBatches,
    createdAt: row.created_at,
    id: row.id,
    manifestPath: row.manifest_path,
    repo: row.repo,
    sourceJson: row.source_json,
    status: row.status,
    updatedAt: row.updated_at,
  };
  if (row.project !== null) candidate.project = row.project;
  if (row.phase !== null) candidate.phase = row.phase;
  if (row.tick_started_at !== null) candidate.tickStartedAt = row.tick_started_at;
  if (row.tick_ended_at !== null) candidate.tickEndedAt = row.tick_ended_at;

  const result = driverRunSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoreSchemaError(
      `driver_runs id=${row.id} failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

function getBatchWithStreams(
  runId: string,
  batchId: string,
  batches: ReturnType<typeof createDriverBatchOps>,
  streams: ReturnType<typeof createDriverStreamOps>,
): DriverBatch {
  const batchRow = batches.listByRunId(runId).find((row) => row.id === batchId);
  if (!batchRow) {
    throw new DriverBatchNotFoundError(batchId);
  }
  const streamRows = streams.listByRunId(runId).filter((row) => row.driver_batch_id === batchId);
  const parsedStreams = streamRows.map((row) => streams.parseRow(row));
  return batches.hydrate(batchRow, parsedStreams);
}

function groupStreamsByBatch(
  streamRows: ReturnType<ReturnType<typeof createDriverStreamOps>["listByRunId"]>,
  streams: ReturnType<typeof createDriverStreamOps>,
): Map<string, DriverStream[]> {
  const out = new Map<string, DriverStream[]>();
  for (const row of streamRows) {
    const stream = streams.parseRow(row);
    const existing = out.get(row.driver_batch_id);
    if (existing) existing.push(stream);
    else out.set(row.driver_batch_id, [stream]);
  }
  return out;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive integer, got ${String(limit)}`);
  }
  if (limit > MAX_LIMIT) {
    throw new RangeError(
      `limit ${String(limit)} exceeds the maximum allowed value ${String(MAX_LIMIT)}`,
    );
  }
  return limit;
}

function buildListSql(
  filter: ListDriverRunsFilter,
  limit: number,
): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.repo !== undefined) {
    where.push("repo = ?");
    params.push(filter.repo);
  }
  if (filter.project !== undefined) {
    where.push("project = ?");
    params.push(filter.project);
  }
  if (filter.phase !== undefined) {
    where.push("phase = ?");
    params.push(filter.phase);
  }
  if (filter.status !== undefined && filter.status.length > 0) {
    const placeholders = filter.status.map(() => "?").join(", ");
    where.push(`status IN (${placeholders})`);
    params.push(...filter.status);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT ${RUN_COLUMNS} FROM driver_runs ${whereClause}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(limit);
  return { params, sql };
}

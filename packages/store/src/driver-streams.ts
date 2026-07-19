/**
 * Per-table module for `driver_streams`. Owns every SQL string that touches
 * the table, plus the parent `driver_runs.updated_at` bump on mutations.
 */

import type { Db } from "./db.js";
import type {
  DriverStream,
  DriverStreamStatus,
  FallbackChainTarget,
  FallbackLogRecord,
  StreamAttempt,
} from "./driver-schemas.js";

import { driverStreamSchema } from "./driver-schemas.js";
import { DriverStreamNotFoundError, StoreSchemaError } from "./errors.js";

/** Patch shape for `updateDriverStream`. */
export interface UpdateDriverStreamInput {
  status?: DriverStreamStatus;
  workflowRunId?: string;
  attempts?: StreamAttempt[];
  branch?: string;
  runtime?: DriverStream["runtime"];
  provider?: DriverStream["provider"] | null;
  workOnCurrentBranch?: boolean | null;
  prNumber?: number;
  prUrl?: string;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
  reviewCycles?: number;
  errorMessage?: string;
  dispatchProvider?: DriverStream["dispatchProvider"] | null;
  dispatchModel?: string | null;
  dispatchModelParams?: DriverStream["dispatchModelParams"] | null;
  effortDegraded?: boolean;
  tierDegradeReason?: string | null;
  /** Rewrite (or `null`-clear) the model id when a hop changes the target. */
  modelId?: DriverStream["modelId"] | null;
  /** Advance the fallback cursor (dispatch-fallback hop); chain stays frozen. */
  fallbackCursor?: number;
  /** Replace the append-only fallback log (caller concatenates). */
  fallbackLog?: FallbackLogRecord[];
}

export interface DriverStreamRow {
  id: string;
  driver_run_id: string;
  driver_batch_id: string;
  stream_index: number;
  task_id: string | null;
  task_slug: string | null;
  spec_path: string;
  branch: string | null;
  runtime: string;
  rolls_up: string | null;
  touches: string;
  status: string;
  workflow_run_id: string | null;
  attempts: string;
  pr_number: number | null;
  pr_url: string | null;
  merge_commit: string | null;
  merged_at: string | null;
  cycles: number | null;
  review_cycles: number | null;
  error_message: string | null;
  model_tier: string | null;
  model_id: string | null;
  effort_tier: string | null;
  provider: string | null;
  dispatch_provider: string | null;
  dispatch_model: string | null;
  dispatch_model_params: string | null;
  effort_degraded: number | null;
  tier_degrade_reason: string | null;
  work_on_current_branch: number | null;
  fallback_chain: string | null;
  fallback_cursor: number | null;
  fallback_log: string | null;
  created_at: string;
  updated_at: string;
}

interface InsertStreamRowInput {
  id: string;
  streamIndex: number;
  taskId?: string;
  taskSlug?: string;
  specPath: string;
  branch?: string;
  runtime: string;
  rollsUp?: string[];
  touches: string[];
  status: DriverStreamStatus;
  workflowRunId?: string;
  attempts: StreamAttempt[];
  prNumber?: number;
  prUrl?: string;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
  reviewCycles?: number;
  errorMessage?: string;
  modelTier?: DriverStream["modelTier"];
  modelId?: DriverStream["modelId"];
  effortTier?: DriverStream["effortTier"];
  provider?: DriverStream["provider"];
  fallbackChain?: FallbackChainTarget[];
  fallbackCursor?: number;
  fallbackLog?: FallbackLogRecord[];
  createdAt: string;
}

/** Internal stream-table API consumed by `driver-runs.ts`. */
export interface DriverStreamOps {
  /** Insert a stream row (caller runs inside aggregate txn). */
  insert: (runId: string, batchId: string, input: InsertStreamRowInput) => void;
  /** Patch progress columns; bumps parent run `updated_at`. */
  update: (id: string, patch: UpdateDriverStreamInput) => DriverStream;
  /** All streams for a run, ordered by `stream_index` (manifest order within each batch). */
  listByRunId: (runId: string) => DriverStreamRow[];
  /** Parse a stream row into a domain `DriverStream`. */
  parseRow: (row: DriverStreamRow) => DriverStream;
}

const STREAM_COLUMNS =
  "id, driver_run_id, driver_batch_id, stream_index, task_id, task_slug, spec_path, branch, runtime, rolls_up, touches, status, workflow_run_id, attempts, pr_number, pr_url, merge_commit, merged_at, cycles, review_cycles, error_message, model_tier, model_id, effort_tier, provider, dispatch_provider, dispatch_model, dispatch_model_params, effort_degraded, tier_degrade_reason, work_on_current_branch, fallback_chain, fallback_cursor, fallback_log, created_at, updated_at";

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
       id, driver_run_id, driver_batch_id, stream_index, task_id, task_slug, spec_path, branch,
       runtime, rolls_up, touches, status, workflow_run_id, attempts, pr_number, pr_url,
       merge_commit, merged_at, cycles, review_cycles, error_message, model_tier, model_id, effort_tier,
       provider, dispatch_provider, dispatch_model, dispatch_model_params, effort_degraded,
       tier_degrade_reason, work_on_current_branch, fallback_chain, fallback_cursor, fallback_log,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectByIdStmt = db.prepare<[string], DriverStreamRow>(
    `SELECT ${STREAM_COLUMNS} FROM driver_streams WHERE id = ?`,
  );
  const selectByRunIdStmt = db.prepare<[string], DriverStreamRow>(
    `SELECT ${STREAM_COLUMNS} FROM driver_streams WHERE driver_run_id = ?
     ORDER BY stream_index ASC, id ASC`,
  );

  function insert(runId: string, batchId: string, input: InsertStreamRowInput): void {
    const now = clock();
    insertStmt.run(
      input.id,
      runId,
      batchId,
      input.streamIndex,
      sqlNull(input.taskId),
      sqlNull(input.taskSlug),
      input.specPath,
      sqlNull(input.branch),
      input.runtime,
      input.rollsUp === undefined ? null : JSON.stringify(input.rollsUp),
      JSON.stringify(input.touches),
      input.status,
      sqlNull(input.workflowRunId),
      JSON.stringify(input.attempts),
      sqlNull(input.prNumber),
      sqlNull(input.prUrl),
      sqlNull(input.mergeCommit),
      sqlNull(input.mergedAt),
      sqlNull(input.cycles),
      sqlNull(input.reviewCycles),
      sqlNull(input.errorMessage),
      sqlNull(input.modelTier),
      sqlNull(input.modelId),
      sqlNull(input.effortTier),
      sqlNull(input.provider),
      null,
      null,
      null,
      null,
      null,
      null,
      input.fallbackChain === undefined ? null : JSON.stringify(input.fallbackChain),
      sqlNull(input.fallbackCursor),
      input.fallbackLog === undefined ? null : JSON.stringify(input.fallbackLog),
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
  appendStreamPatchColumn(sets, params, "branch = ?", patch.branch);
  appendStreamPatchColumn(sets, params, "runtime = ?", patch.runtime);
  appendStreamPatchColumn(sets, params, "provider = ?", patch.provider);
  appendStreamPatchColumn(sets, params, "pr_number = ?", patch.prNumber);
  appendStreamPatchColumn(sets, params, "pr_url = ?", patch.prUrl);
  appendStreamPatchColumn(sets, params, "merge_commit = ?", patch.mergeCommit);
  appendStreamPatchColumn(sets, params, "merged_at = ?", patch.mergedAt);
  appendStreamPatchColumn(sets, params, "cycles = ?", patch.cycles);
  appendStreamPatchColumn(sets, params, "review_cycles = ?", patch.reviewCycles);
  appendStreamPatchColumn(sets, params, "error_message = ?", patch.errorMessage);
  appendStreamPatchColumn(sets, params, "dispatch_provider = ?", patch.dispatchProvider);
  appendStreamPatchColumn(sets, params, "dispatch_model = ?", patch.dispatchModel);
  appendStreamPatchColumn(sets, params, "model_id = ?", patch.modelId);
  appendStreamPatchColumn(
    sets,
    params,
    "dispatch_model_params = ?",
    patch.dispatchModelParams,
    (value) => (value === null ? null : JSON.stringify(value)),
  );
  appendStreamPatchColumn(sets, params, "effort_degraded = ?", patch.effortDegraded, boolToInt);
  appendStreamPatchColumn(sets, params, "tier_degrade_reason = ?", patch.tierDegradeReason);
  appendStreamPatchColumn(
    sets,
    params,
    "work_on_current_branch = ?",
    patch.workOnCurrentBranch,
    (value) => (value === null ? null : boolToInt(value)),
  );
  appendStreamPatchColumn(sets, params, "fallback_cursor = ?", patch.fallbackCursor);
  appendStreamPatchColumn(sets, params, "fallback_log = ?", patch.fallbackLog, JSON.stringify);
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

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

interface StreamJsonColumns {
  touches: unknown;
  attempts: unknown;
  dispatchModelParams: unknown;
  rollsUp: unknown;
  fallbackChain: unknown;
  fallbackLog: unknown;
}

// Parse every JSON-encoded column in one place. A malformed value in any of
// them is one malformed-row error, not a per-column branch in parseStreamRow.
function parseStreamJsonColumns(row: DriverStreamRow): StreamJsonColumns {
  try {
    return {
      touches: JSON.parse(row.touches),
      attempts: JSON.parse(row.attempts),
      dispatchModelParams:
        row.dispatch_model_params === null ? undefined : JSON.parse(row.dispatch_model_params),
      rollsUp: row.rolls_up === null ? undefined : JSON.parse(row.rolls_up),
      fallbackChain: row.fallback_chain === null ? undefined : JSON.parse(row.fallback_chain),
      fallbackLog: row.fallback_log === null ? undefined : JSON.parse(row.fallback_log),
    };
  } catch (err: unknown) {
    throw new StoreSchemaError(`driver_streams id=${row.id} has malformed JSON column`, {
      cause: err,
    });
  }
}

function parseStreamRow(row: DriverStreamRow): DriverStream {
  const { touches, attempts, dispatchModelParams, rollsUp, fallbackChain, fallbackLog } =
    parseStreamJsonColumns(row);
  const candidate = {
    attempts,
    createdAt: row.created_at,
    driverBatchId: row.driver_batch_id,
    driverRunId: row.driver_run_id,
    id: row.id,
    runtime: row.runtime,
    specPath: row.spec_path,
    status: row.status,
    streamIndex: row.stream_index,
    touches,
    updatedAt: row.updated_at,
    ...optionalStreamFields(row),
    ...(dispatchModelParams !== undefined ? { dispatchModelParams } : {}),
    ...(rollsUp !== undefined ? { rollsUp } : {}),
    ...(fallbackChain !== undefined ? { fallbackChain } : {}),
    ...(fallbackLog !== undefined ? { fallbackLog } : {}),
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

function optionalStreamFields(row: DriverStreamRow): Record<string, string | number | boolean> {
  const entries: [string, string | number | boolean | null][] = [
    ["branch", row.branch],
    ["cycles", row.cycles],
    ["reviewCycles", row.review_cycles],
    ["dispatchModel", row.dispatch_model],
    ["dispatchProvider", row.dispatch_provider],
    ["effortDegraded", row.effort_degraded === null ? null : row.effort_degraded === 1],
    ["effortTier", row.effort_tier],
    ["errorMessage", row.error_message],
    ["fallbackCursor", row.fallback_cursor],
    ["mergeCommit", row.merge_commit],
    ["mergedAt", row.merged_at],
    ["modelId", row.model_id],
    ["modelTier", row.model_tier],
    ["prNumber", row.pr_number],
    ["prUrl", row.pr_url],
    ["provider", row.provider],
    ["taskId", row.task_id],
    ["taskSlug", row.task_slug],
    ["tierDegradeReason", row.tier_degrade_reason],
    [
      "workOnCurrentBranch",
      row.work_on_current_branch === null ? null : row.work_on_current_branch === 1,
    ],
    ["workflowRunId", row.workflow_run_id],
  ];
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string | number | boolean] => entry[1] !== null),
  );
}

export { parseStreamRow };

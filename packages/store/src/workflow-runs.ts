/**
 * Per-table module for `workflow_runs`. Owns SQL plus the row → domain
 * hydration that combines a row with its phases (via `PhaseOps`).
 */

import type { WorkflowPolicy, WorkflowRun, WorkflowStatus, WorktreeRef } from "@ship/workflow";
import type { Statement } from "better-sqlite3";

import { workflowRunSchema } from "@ship/workflow";

import type { Db } from "./db.js";
import type { PhaseOps } from "./phases.js";

import { StoreSchemaError, WorkflowRunNotFoundError } from "./errors.js";

/** Default `listRuns` row cap when the caller doesn't pass one. */
const DEFAULT_LIMIT = 50;
/** Hard upper bound on `listRuns` row cap; over-max throws. */
const MAX_LIMIT = 200;

/**
 * Inputs for `createWorkflowRun`. Caller supplies a `wf_<ulid>` id;
 * status is forced to `"pending"` and is not part of the input.
 */
export interface CreateWorkflowRunInput {
  id: string;
  repo: string;
  docPath: string;
  baseRef: string;
  worktree: WorktreeRef;
  policy: WorkflowPolicy;
}

/**
 * Filter for `listRuns`. `status` is an IN-clause (empty array = no
 * filter); `limit` defaults to 50 and throws `RangeError` if > 200 or
 * non-positive.
 */
export interface ListRunsFilter {
  repo?: string;
  status?: WorkflowStatus[];
  limit?: number;
}

/** Internal workflow-run-table API consumed by `store.ts`. */
export interface WorkflowRunOps {
  /** Insert a new workflow run with `status = 'pending'`; returns the hydrated row. */
  create: (input: CreateWorkflowRunInput) => WorkflowRun;
  /** Flip the run's `status` and bump `updated_at`; throws if id unknown. */
  updateStatus: (id: string, status: WorkflowStatus) => WorkflowRun;
  /** Hydrated row + phases, or `null` if the id is unknown. */
  get: (id: string) => WorkflowRun | null;
  /** Filtered + ordered + limited list; two queries total regardless of N. */
  list: (filter: ListRunsFilter) => WorkflowRun[];
  /** Idempotent cancel; terminal rows return as-is, non-terminal flip in one transaction. */
  cancel: (id: string) => WorkflowRun;
}

interface WorkflowRunRow {
  id: string;
  repo: string;
  doc_path: string;
  status: string;
  base_ref: string;
  worktree_json: string;
  policy_json: string;
  created_at: string;
  updated_at: string;
}

const WORKFLOW_RUN_COLUMNS =
  "id, repo, doc_path, status, base_ref, worktree_json, policy_json, created_at, updated_at";

interface WorkflowRunStmts {
  insert: Statement;
  selectById: Statement<[string], WorkflowRunRow>;
  updateStatus: Statement;
  /**
   * Conditional UPDATE that only flips non-terminal rows. Combined with
   * `result.changes`, lets `cancel` decide atomically whether a cancel
   * happened so a concurrent terminal write is never overwritten.
   */
  conditionalCancel: Statement;
}

/** Bundle threaded into helpers to stay under the eslint param cap. */
interface WorkflowRunDeps {
  db: Db;
  stmts: WorkflowRunStmts;
  phases: PhaseOps;
  clock: () => string;
}

/**
 * Constructs the `workflow_runs` ops. `PhaseOps` is required because
 * hydration fetches phases per run and `cancel` flips in-flight phases
 * in the same txn. Caches static prepared statements (ED-6); the
 * dynamic-WHERE `list` builds SQL per call.
 */
export function createWorkflowRunOps(
  db: Db,
  clock: () => string,
  phases: PhaseOps,
): WorkflowRunOps {
  const stmts: WorkflowRunStmts = {
    conditionalCancel: db.prepare(
      `UPDATE workflow_runs SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')`,
    ),
    insert: db.prepare(
      `INSERT INTO workflow_runs (id, repo, doc_path, status, base_ref, worktree_json, policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectById: db.prepare<[string], WorkflowRunRow>(
      `SELECT ${WORKFLOW_RUN_COLUMNS} FROM workflow_runs WHERE id = ?`,
    ),
    updateStatus: db.prepare(`UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?`),
  };
  const deps: WorkflowRunDeps = { clock, db, phases, stmts };

  return {
    cancel: (id) => cancelRun(deps, id),
    create: (input) => createRun(deps, input),
    get: (id) => getRun(deps, id),
    list: (filter) => listRunsImpl(deps, filter),
    updateStatus: (id, status) => updateRunStatus(deps, id, status),
  };
}

/** Hydrate a row + its phases into a `WorkflowRun`. */
function hydrateOne(phases: PhaseOps, row: WorkflowRunRow): WorkflowRun {
  return parseRun(row, phases.listByRunId(row.id));
}

/** INSERT + hydrate in one txn so a Zod-rejecting post-state rolls back. */
function createRun(deps: WorkflowRunDeps, input: CreateWorkflowRunInput): WorkflowRun {
  const txn = deps.db.transaction((): WorkflowRun => {
    const now = deps.clock();
    deps.stmts.insert.run(
      input.id,
      input.repo,
      input.docPath,
      "pending",
      input.baseRef,
      JSON.stringify(input.worktree),
      JSON.stringify(input.policy),
      now,
      now,
    );
    const row = deps.stmts.selectById.get(input.id);
    if (!row) {
      throw new Error(`internal: just-inserted workflow run ${input.id} not found`);
    }
    return parseRun(row, []);
  });
  return txn();
}

/** UPDATE + hydrate in one txn; same atomicity guarantee as `createRun`. */
function updateRunStatus(deps: WorkflowRunDeps, id: string, status: WorkflowStatus): WorkflowRun {
  const txn = deps.db.transaction((): WorkflowRun => {
    const result = deps.stmts.updateStatus.run(status, deps.clock(), id);
    if (result.changes === 0) {
      throw new WorkflowRunNotFoundError(id);
    }
    const row = deps.stmts.selectById.get(id);
    if (!row) {
      throw new Error(`internal: workflow run ${id} vanished after status update`);
    }
    return hydrateOne(deps.phases, row);
  });
  return txn();
}

function getRun(deps: WorkflowRunDeps, id: string): WorkflowRun | null {
  const row = deps.stmts.selectById.get(id);
  return row ? hydrateOne(deps.phases, row) : null;
}

function listRunsImpl(deps: WorkflowRunDeps, filter: ListRunsFilter): WorkflowRun[] {
  const limit = clampLimit(filter.limit);
  const { sql, params } = buildListSql(filter, limit);
  const rows = deps.db.prepare<unknown[], WorkflowRunRow>(sql).all(...params);
  if (rows.length === 0) return [];
  const grouped = deps.phases.listByRunIds(rows.map((r) => r.id));
  return rows.map((row) => parseRun(row, grouped.get(row.id) ?? []));
}

/**
 * Idempotent, race-safe cancel via a single conditional UPDATE: lets the
 * "already terminal?" check and the cancel write happen atomically so a
 * concurrent terminal write from another connection is never overwritten.
 * `result.changes === 1` → also flip in-flight phases in the same txn;
 * `=== 0` → row didn't exist (post-lookup throws) or was already terminal.
 */
function cancelRun(deps: WorkflowRunDeps, id: string): WorkflowRun {
  const txn = deps.db.transaction((): WorkflowRun => {
    const now = deps.clock();
    const result = deps.stmts.conditionalCancel.run(now, id);
    if (result.changes > 0) {
      deps.phases.cancelInFlightForRun(id, now);
    }
    const row = deps.stmts.selectById.get(id);
    if (!row) {
      throw new WorkflowRunNotFoundError(id);
    }
    return hydrateOne(deps.phases, row);
  });
  return txn();
}

/**
 * Validates and normalizes a `listRuns` limit. Default 50, max 200;
 * throws `RangeError` for over-max or non-positive.
 */
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

/**
 * Builds the dynamic `SELECT ... FROM workflow_runs` SQL for `listRuns`.
 * Tiebreak is `created_at DESC, id DESC` — same-ms collisions are broken
 * by larger-id-first, which preserves "newer first" since ULIDs embed time.
 */
function buildListSql(filter: ListRunsFilter, limit: number): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.repo !== undefined) {
    where.push("repo = ?");
    params.push(filter.repo);
  }
  if (filter.status !== undefined && filter.status.length > 0) {
    const placeholders = filter.status.map(() => "?").join(", ");
    where.push(`status IN (${placeholders})`);
    params.push(...filter.status);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT ${WORKFLOW_RUN_COLUMNS} FROM workflow_runs ${whereClause}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(limit);
  return { params, sql };
}

/**
 * Builds a `WorkflowRun` candidate from a row + its phases and runs
 * `workflowRunSchema.parse`. Failed `JSON.parse` of the two JSON blobs
 * is wrapped as `StoreSchemaError` for uniform handling with Zod failures.
 */
function parseRun(row: WorkflowRunRow, runPhases: WorkflowRun["phases"]): WorkflowRun {
  let worktree: unknown;
  let policy: unknown;
  try {
    worktree = JSON.parse(row.worktree_json);
    policy = JSON.parse(row.policy_json);
  } catch (err: unknown) {
    throw new StoreSchemaError(`workflow_runs id=${row.id} has malformed JSON column`, {
      cause: err,
    });
  }
  const candidate = {
    baseRef: row.base_ref,
    createdAt: row.created_at,
    docPath: row.doc_path,
    id: row.id,
    phases: runPhases,
    policy,
    repo: row.repo,
    status: row.status,
    updatedAt: row.updated_at,
    worktree,
  };
  const result = workflowRunSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoreSchemaError(
      `workflow_runs id=${row.id} failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

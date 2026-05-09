/**
 * Per-table module for `workflow_runs`.
 *
 * Owns every SQL string that touches `workflow_runs`, plus the
 * row → domain hydration that combines a workflow row with its phases
 * (delegated to `PhaseOps`). Returns hydrated `WorkflowRun` shapes from
 * `get`, `list`, every mutator, and `cancel`.
 *
 * Methods exposed to `store.ts`:
 * - `create`        — INSERT a fresh row with `status = 'pending'`.
 * - `updateStatus`  — flip `status` and bump `updated_at`. Does NOT
 *                     check the workflow state machine; `core` does
 *                     that with `canTransition` from `@ship/workflow`
 *                     before invoking. (See § F2 / ED rationale.)
 * - `get`           — single row + its phases, hydrated.
 * - `list`          — filter + order + limit, plus phases for the
 *                     matched runs in one extra query. Two queries
 *                     total, regardless of N (per § F3).
 * - `cancel`        — idempotent. Terminal runs: read-only return.
 *                     Non-terminal: one transaction flips the run to
 *                     `cancelled` and any in-flight phase to
 *                     `cancelled` with `endedAt = clock()`.
 *
 * Hydration uses Zod's `workflowRunSchema.parse` at the seam: column
 * drift, malformed JSON blobs, or missing fields throw
 * `StoreSchemaError` immediately rather than leaking through `core`.
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

/** Internal: status values that are sticky and require no further mutation on `cancel`. */
const TERMINAL_STATUSES = new Set<string>(["succeeded", "failed", "cancelled"]);

/**
 * Inputs accepted by `createWorkflowRun`.
 *
 * Mirrors phases/03-store.md § F2. The store is responsible only for
 * persisting these fields verbatim; it does NOT generate ids (the caller
 * passes a `wf_<ulid>` from `@ship/workflow`'s `newWorkflowRunId()`) and
 * it does NOT default the policy (`core` does, falling back to
 * `DEFAULT_WORKFLOW_POLICY`). `status` is forced to `"pending"` and is
 * not part of the input.
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
 * Filter shape for `listRuns`.
 *
 * - `repo`   — exact-match.
 * - `status` — IN-clause; an empty array is treated as "no status filter."
 * - `limit`  — defaults to 50; throws `RangeError` if greater than 200
 *              or non-positive (the schema-level invariant `core` is
 *              meant to enforce, but the store double-checks).
 */
export interface ListRunsFilter {
  repo?: string;
  status?: WorkflowStatus[];
  limit?: number;
}

/**
 * The internal workflow-run-table API consumed by `store.ts`.
 *
 * Not re-exported from the package barrel; only the public `Store`
 * interface in `store.ts` is.
 */
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

/** Internal: shape of one row returned by every `SELECT * FROM workflow_runs`. */
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

/** Column list shared by every `SELECT` against `workflow_runs`. */
const WORKFLOW_RUN_COLUMNS =
  "id, repo, doc_path, status, base_ref, worktree_json, policy_json, created_at, updated_at";

/**
 * Internal: the prepared statements every method in this module needs.
 * Built once by `createWorkflowRunOps` and threaded into the per-method
 * helpers (which live at the top level so the factory function fits
 * inside the lint cap).
 */
interface WorkflowRunStmts {
  insert: Statement;
  selectById: Statement<[string], WorkflowRunRow>;
  updateStatus: Statement;
}

/**
 * Constructs the `workflow_runs` ops bound to a given DB connection,
 * clock, and `PhaseOps` instance. The `PhaseOps` dependency exists
 * because hydration needs to fetch phases per run, and `cancel` needs to
 * flip in-flight phases inside the same transaction as the run-status
 * flip.
 *
 * Caches every static prepared statement at construction time per ED-6.
 * The dynamic-WHERE `list` builds SQL on the fly because the WHERE shape
 * varies per call.
 */
export function createWorkflowRunOps(
  db: Db,
  clock: () => string,
  phases: PhaseOps,
): WorkflowRunOps {
  const stmts: WorkflowRunStmts = {
    insert: db.prepare(
      `INSERT INTO workflow_runs (id, repo, doc_path, status, base_ref, worktree_json, policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectById: db.prepare<[string], WorkflowRunRow>(
      `SELECT ${WORKFLOW_RUN_COLUMNS} FROM workflow_runs WHERE id = ?`,
    ),
    updateStatus: db.prepare(`UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?`),
  };

  return {
    cancel: (id) => cancelRun(db, stmts, phases, clock, id),
    create: (input) => createRun(stmts, clock, input),
    get: (id) => getRun(stmts, phases, id),
    list: (filter) => listRunsImpl(db, phases, filter),
    updateStatus: (id, status) => updateRunStatus(stmts, phases, clock, id, status),
  };
}

/**
 * Look up a single row by id and hydrate it into a `WorkflowRun`. Caller
 * passes an already-fetched row to avoid a redundant SELECT inside the
 * mutator paths (`updateStatus`, `cancel`) where the row was just
 * touched.
 */
function hydrateOne(phases: PhaseOps, row: WorkflowRunRow): WorkflowRun {
  return parseRun(row, phases.listByRunId(row.id));
}

function createRun(
  stmts: WorkflowRunStmts,
  clock: () => string,
  input: CreateWorkflowRunInput,
): WorkflowRun {
  const now = clock();
  stmts.insert.run(
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
  const row = stmts.selectById.get(input.id);
  if (!row) {
    throw new Error(`internal: just-inserted workflow run ${input.id} not found`);
  }
  return parseRun(row, []);
}

function updateRunStatus(
  stmts: WorkflowRunStmts,
  phases: PhaseOps,
  clock: () => string,
  id: string,
  status: WorkflowStatus,
): WorkflowRun {
  const result = stmts.updateStatus.run(status, clock(), id);
  if (result.changes === 0) {
    throw new WorkflowRunNotFoundError(id);
  }
  const row = stmts.selectById.get(id);
  if (!row) {
    throw new Error(`internal: workflow run ${id} vanished after status update`);
  }
  return hydrateOne(phases, row);
}

function getRun(stmts: WorkflowRunStmts, phases: PhaseOps, id: string): WorkflowRun | null {
  const row = stmts.selectById.get(id);
  return row ? hydrateOne(phases, row) : null;
}

function listRunsImpl(db: Db, phases: PhaseOps, filter: ListRunsFilter): WorkflowRun[] {
  const limit = clampLimit(filter.limit);
  const { sql, params } = buildListSql(filter, limit);
  const rows = db.prepare<unknown[], WorkflowRunRow>(sql).all(...params);
  if (rows.length === 0) return [];
  const grouped = phases.listByRunIds(rows.map((r) => r.id));
  return rows.map((row) => parseRun(row, grouped.get(row.id) ?? []));
}

function cancelRun(
  db: Db,
  stmts: WorkflowRunStmts,
  phases: PhaseOps,
  clock: () => string,
  id: string,
): WorkflowRun {
  const existing = stmts.selectById.get(id);
  if (!existing) {
    throw new WorkflowRunNotFoundError(id);
  }
  if (TERMINAL_STATUSES.has(existing.status)) {
    return hydrateOne(phases, existing);
  }
  const txn = db.transaction((): void => {
    const now = clock();
    stmts.updateStatus.run("cancelled", now, id);
    phases.cancelInFlightForRun(id, now);
  });
  txn();
  const updated = stmts.selectById.get(id);
  if (!updated) {
    throw new Error(`internal: workflow run ${id} vanished after cancel`);
  }
  return hydrateOne(phases, updated);
}

/**
 * Validates and normalizes a `listRuns` `limit` value.
 *
 * Throws `RangeError` for over-max or non-positive, matching the
 * spec.md / phases/03-store.md contract (`default 50, max 200`). `core`
 * is expected to enforce this at the MCP boundary; the store
 * double-checks because the same code path is reachable from `cli` and
 * tests, neither of which sit behind that boundary.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`listRuns limit must be a positive integer, got ${String(limit)}`);
  }
  if (limit > MAX_LIMIT) {
    throw new RangeError(`listRuns limit ${String(limit)} exceeds maximum ${String(MAX_LIMIT)}`);
  }
  return limit;
}

/**
 * Builds the dynamic `SELECT ... FROM workflow_runs` SQL for `listRuns`.
 *
 * Returns the full SQL string plus the bind parameters in the order the
 * `?` placeholders appear. The ordering tiebreak is `created_at DESC,
 * id DESC` — `created_at` is at ms resolution and may collide; ULIDs
 * embed time in their first chars, so larger-id-first preserves
 * "newer first" inside a millisecond.
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
 * `workflowRunSchema.parse`.
 *
 * The two JSON blobs (`worktree_json`, `policy_json`) are parsed here
 * with a `try`/`catch` that wraps `SyntaxError` into `StoreSchemaError`
 * — failed `JSON.parse` is the most likely "manual corruption" failure
 * mode and rewriting it as a typed error keeps the catch surface
 * uniform with Zod-parse failures.
 *
 * On schema-parse failure, throws `StoreSchemaError` with the offending
 * id baked into the message and the underlying `ZodError` as `cause`.
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

/**
 * Per-table module for `merge_grants` and `merge_grant_satisfactions`.
 */

import { ulid } from "ulid";

import type { Db } from "./db.js";
import type { MergeGrant, MergeGrantSatisfaction } from "./merge-grant-schemas.js";

import { StoreSchemaError } from "./errors.js";
import { mergeGrantSatisfactionSchema, mergeGrantSchema } from "./merge-grant-schemas.js";

/** Returns a new merge-grant ID, e.g. `mg_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newMergeGrantId(): string {
  return `mg_${ulid()}`;
}

/** Returns a new satisfaction audit ID, e.g. `mgs_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newMergeGrantSatisfactionId(): string {
  return `mgs_${ulid()}`;
}

export interface RegisterMergeGrantInput {
  repo: string;
}

export interface RecordMergeGrantSatisfactionInput {
  driverRunId: string;
  driverStreamId: string;
  grantId: string;
  mergeCommit: string;
  prNumber: number;
  verdictJson: string;
}

interface MergeGrantRow {
  granted_at: string;
  id: string;
  repo: string;
  revoked_at: string | null;
}

interface MergeGrantSatisfactionRow {
  driver_run_id: string;
  driver_stream_id: string;
  grant_id: string;
  id: string;
  merge_commit: string;
  pr_number: number;
  satisfied_at: string;
  verdict_json: string;
}

export interface MergeGrantOps {
  /** Register (or refresh) an active repo-scoped merge grant. Idempotent per repo. */
  register: (input: RegisterMergeGrantInput) => MergeGrant;
  /** Active grant for `repo`, or `null` when none / revoked. */
  getActive: (repo: string) => MergeGrant | null;
  /** Append a per-PR satisfaction audit row. */
  recordSatisfaction: (input: RecordMergeGrantSatisfactionInput) => MergeGrantSatisfaction;
  /** Satisfaction rows for a stream (newest first). */
  listSatisfactionsByStream: (driverStreamId: string) => MergeGrantSatisfaction[];
}

/**
 * Normalize repo keys to `owner/repo` lowercase for grant lookup consistency.
 */
export function normalizeMergeGrantRepo(repo: string): string {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(repo);
  const slug = match?.[1] ?? repo;
  return slug.toLowerCase();
}

export function createMergeGrantOps(db: Db, clock: () => string): MergeGrantOps {
  const selectActiveStmt = db.prepare<[string], MergeGrantRow>(
    `SELECT id, repo, granted_at, revoked_at
     FROM merge_grants
     WHERE repo = ? AND revoked_at IS NULL
     ORDER BY granted_at DESC
     LIMIT 1`,
  );
  const insertGrantStmt = db.prepare(
    `INSERT INTO merge_grants (id, repo, granted_at, revoked_at)
     VALUES (?, ?, ?, NULL)`,
  );
  const insertSatisfactionStmt = db.prepare(
    `INSERT INTO merge_grant_satisfactions (
       id, grant_id, driver_run_id, driver_stream_id, pr_number, verdict_json, merge_commit, satisfied_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectSatisfactionsByStreamStmt = db.prepare<[string], MergeGrantSatisfactionRow>(
    `SELECT id, grant_id, driver_run_id, driver_stream_id, pr_number, verdict_json, merge_commit, satisfied_at
     FROM merge_grant_satisfactions
     WHERE driver_stream_id = ?
     ORDER BY satisfied_at DESC`,
  );

  function register(input: RegisterMergeGrantInput): MergeGrant {
    const repo = normalizeMergeGrantRepo(input.repo);
    const now = clock();
    const existing = selectActiveStmt.get(repo);
    if (existing !== undefined) {
      return parseGrantRow(existing);
    }
    const id = newMergeGrantId();
    insertGrantStmt.run(id, repo, now);
    const row = selectActiveStmt.get(repo);
    if (row === undefined) {
      throw new Error(`internal: merge grant for ${repo} missing after insert`);
    }
    return parseGrantRow(row);
  }

  function getActive(repo: string): MergeGrant | null {
    const row = selectActiveStmt.get(normalizeMergeGrantRepo(repo));
    if (row === undefined) return null;
    return parseGrantRow(row);
  }

  function recordSatisfaction(input: RecordMergeGrantSatisfactionInput): MergeGrantSatisfaction {
    const id = newMergeGrantSatisfactionId();
    const now = clock();
    insertSatisfactionStmt.run(
      id,
      input.grantId,
      input.driverRunId,
      input.driverStreamId,
      input.prNumber,
      input.verdictJson,
      input.mergeCommit,
      now,
    );
    const rows = selectSatisfactionsByStreamStmt.all(input.driverStreamId);
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      throw new Error(`internal: merge grant satisfaction ${id} missing after insert`);
    }
    return parseSatisfactionRow(row);
  }

  function listSatisfactionsByStream(driverStreamId: string): MergeGrantSatisfaction[] {
    return selectSatisfactionsByStreamStmt.all(driverStreamId).map(parseSatisfactionRow);
  }

  return { getActive, listSatisfactionsByStream, recordSatisfaction, register };
}

function parseGrantRow(row: MergeGrantRow): MergeGrant {
  const candidate = {
    grantedAt: row.granted_at,
    id: row.id,
    repo: row.repo,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
  const result = mergeGrantSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoreSchemaError(
      `merge_grants id=${row.id} failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

function parseSatisfactionRow(row: MergeGrantSatisfactionRow): MergeGrantSatisfaction {
  const candidate = {
    driverRunId: row.driver_run_id,
    driverStreamId: row.driver_stream_id,
    grantId: row.grant_id,
    id: row.id,
    mergeCommit: row.merge_commit,
    prNumber: row.pr_number,
    satisfiedAt: row.satisfied_at,
    verdictJson: row.verdict_json,
  };
  const result = mergeGrantSatisfactionSchema.safeParse(candidate);
  if (!result.success) {
    throw new StoreSchemaError(
      `merge_grant_satisfactions id=${row.id} failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

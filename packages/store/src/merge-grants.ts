/**
 * Repo-scoped merge-grant persistence — policy registration + per-PR audit rows.
 */

import { z } from "zod";

import type { Db } from "./db.js";

import { StoreSchemaError } from "./errors.js";
import { newMergeGrantId, newMergeGrantSatisfactionId } from "./merge-grant-ids.js";

export const repoMergeGrantSchema = z
  .object({
    grantedAt: z.string().datetime({ offset: true }),
    id: z.string(),
    repo: z.string(),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const mergeGrantSatisfactionSchema = z
  .object({
    driverRunId: z.string().optional(),
    driverStreamId: z.string().optional(),
    grantId: z.string(),
    id: z.string(),
    mergeCommit: z.string().optional(),
    prNumber: z.number().int(),
    repo: z.string(),
    satisfiedAt: z.string().datetime({ offset: true }),
    verdictJson: z.string(),
  })
  .strict();

export type RepoMergeGrant = z.infer<typeof repoMergeGrantSchema>;
export type MergeGrantSatisfaction = z.infer<typeof mergeGrantSatisfactionSchema>;

export interface RecordMergeGrantSatisfactionInput {
  grantId: string;
  repo: string;
  prNumber: number;
  verdictJson: string;
  driverRunId?: string;
  driverStreamId?: string;
  mergeCommit?: string;
}

interface MergeGrantRow {
  granted_at: string;
  id: string;
  repo: string;
  revoked_at: string | null;
}

interface SatisfactionRow {
  driver_run_id: string | null;
  driver_stream_id: string | null;
  grant_id: string;
  id: string;
  merge_commit: string | null;
  pr_number: number;
  repo: string;
  satisfied_at: string;
  verdict_json: string;
}

export interface MergeGrantOps {
  registerRepoMergeGrant: (repo: string) => RepoMergeGrant;
  getActiveRepoMergeGrant: (repo: string) => RepoMergeGrant | null;
  recordMergeGrantSatisfaction: (
    input: RecordMergeGrantSatisfactionInput,
  ) => MergeGrantSatisfaction;
  getMergeGrantSatisfaction: (repo: string, prNumber: number) => MergeGrantSatisfaction | null;
}

/** Normalize repo slug to lowercase owner/repo for grant lookup. */
export function normalizeMergeGrantRepo(repo: string): string {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(repo.trim());
  if (match?.[1] !== undefined) {
    return match[1].toLowerCase();
  }
  return repo.trim().toLowerCase();
}

export function createMergeGrantOps(db: Db, clock: () => string): MergeGrantOps {
  const insertGrantStmt = db.prepare(
    "INSERT INTO repo_merge_grants (id, repo, granted_at, revoked_at) VALUES (?, ?, ?, NULL)",
  );
  const revokeGrantStmt = db.prepare(
    "UPDATE repo_merge_grants SET revoked_at = ? WHERE repo = ? AND revoked_at IS NULL",
  );
  const selectActiveGrantStmt = db.prepare<[string], MergeGrantRow>(
    "SELECT id, repo, granted_at, revoked_at FROM repo_merge_grants WHERE repo = ? AND revoked_at IS NULL",
  );
  const insertSatisfactionStmt = db.prepare(
    `INSERT INTO merge_grant_satisfactions
      (id, grant_id, repo, pr_number, driver_run_id, driver_stream_id, verdict_json, merge_commit, satisfied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectSatisfactionStmt = db.prepare<[string, number], SatisfactionRow>(
    `SELECT id, grant_id, repo, pr_number, driver_run_id, driver_stream_id, verdict_json, merge_commit, satisfied_at
     FROM merge_grant_satisfactions WHERE repo = ? AND pr_number = ?`,
  );

  return {
    getActiveRepoMergeGrant(repo: string): RepoMergeGrant | null {
      const normalized = normalizeMergeGrantRepo(repo);
      const row = selectActiveGrantStmt.get(normalized);
      if (row === undefined) return null;
      return hydrateGrant(row);
    },

    getMergeGrantSatisfaction(repo: string, prNumber: number): MergeGrantSatisfaction | null {
      const normalized = normalizeMergeGrantRepo(repo);
      const row = selectSatisfactionStmt.get(normalized, prNumber);
      if (row === undefined) return null;
      return hydrateSatisfaction(row);
    },

    registerRepoMergeGrant(repo: string): RepoMergeGrant {
      const normalized = normalizeMergeGrantRepo(repo);
      const grantedAt = clock();
      const txn = db.transaction(() => {
        revokeGrantStmt.run(grantedAt, normalized);
        insertGrantStmt.run(newMergeGrantId(), normalized, grantedAt);
      });
      txn.immediate();
      const row = selectActiveGrantStmt.get(normalized);
      if (row === undefined) {
        throw new StoreSchemaError(`merge grant insert failed for repo ${normalized}`);
      }
      return hydrateGrant(row);
    },

    recordMergeGrantSatisfaction(input: RecordMergeGrantSatisfactionInput): MergeGrantSatisfaction {
      const normalized = normalizeMergeGrantRepo(input.repo);
      const id = newMergeGrantSatisfactionId();
      const satisfiedAt = clock();
      insertSatisfactionStmt.run(
        id,
        input.grantId,
        normalized,
        input.prNumber,
        input.driverRunId ?? null,
        input.driverStreamId ?? null,
        input.verdictJson,
        input.mergeCommit ?? null,
        satisfiedAt,
      );
      const row = selectSatisfactionStmt.get(normalized, input.prNumber);
      if (row === undefined) {
        throw new StoreSchemaError(
          `merge grant satisfaction insert failed for ${normalized}#${String(input.prNumber)}`,
        );
      }
      return hydrateSatisfaction(row);
    },
  };
}

function hydrateGrant(row: MergeGrantRow): RepoMergeGrant {
  const parsed = repoMergeGrantSchema.safeParse({
    grantedAt: row.granted_at,
    id: row.id,
    repo: row.repo,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  });
  if (!parsed.success) {
    throw new StoreSchemaError(`invalid repo_merge_grants row ${row.id}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function hydrateSatisfaction(row: SatisfactionRow): MergeGrantSatisfaction {
  const parsed = mergeGrantSatisfactionSchema.safeParse({
    driverRunId: row.driver_run_id ?? undefined,
    driverStreamId: row.driver_stream_id ?? undefined,
    grantId: row.grant_id,
    id: row.id,
    mergeCommit: row.merge_commit ?? undefined,
    prNumber: row.pr_number,
    repo: row.repo,
    satisfiedAt: row.satisfied_at,
    verdictJson: row.verdict_json,
  });
  if (!parsed.success) {
    throw new StoreSchemaError(
      `invalid merge_grant_satisfactions row ${row.id}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

import type { AgentProvider } from "@ship/workflow";

import type { Db } from "./db.js";
import type { StreamAttempt } from "./driver-schemas.js";

import { ReviewArtifactAddressRacedError, ReviewArtifactDuplicateError } from "./errors.js";

export interface ReviewArtifactReceiptFacts {
  artifactId: string;
  canonicalSha256: string;
  driverRunId: string;
  streamId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  producerId: string;
  producerHarness: string;
  producerCatalogRevision?: string;
  addressCycle: number;
  docPath: string;
  dispatchProvider: AgentProvider;
  dispatchModel?: string;
}

export interface ConsumeReviewArtifactInput extends ReviewArtifactReceiptFacts {
  expectedReviewCycle: number;
  attempts: StreamAttempt[];
  dispatchModelParams?: { id: string; value: string | boolean }[];
  effortDegraded?: boolean;
  tierDegradeReason?: string;
}

export interface ReviewArtifactOps {
  consumeAndPrepareDispatch: (input: ConsumeReviewArtifactInput) => void;
  /** Return the consumed `head_sha` for a run+stream+cycle triple, or undefined if absent. */
  getConsumedHeadSha: (driverRunId: string, streamId: string, cycle: number) => string | undefined;
  /** Return durable receipt facts for exact-head ledger recovery, or undefined for legacy rows. */
  getReceiptFacts: (
    driverRunId: string,
    streamId: string,
    cycle: number,
  ) => ReviewArtifactReceiptFacts | undefined;
}

export function createReviewArtifactOps(db: Db, clock: () => string): ReviewArtifactOps {
  const insert = db.prepare(
    `INSERT INTO driver_review_artifacts (
       artifact_id, canonical_sha256, driver_run_id, stream_id, repo, pr_number,
       head_sha, address_cycle, doc_path, consumed_at, producer_id, producer_harness,
       producer_catalog_revision, dispatch_provider, dispatch_model
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStream = db.prepare(
    `UPDATE driver_streams
     SET attempts = ?, status = 'dispatching', review_cycles = ?, workflow_run_id = NULL,
         work_on_current_branch = 1, dispatch_provider = ?, dispatch_model = ?,
         dispatch_model_params = ?, effort_degraded = ?, tier_degrade_reason = ?,
         updated_at = ?
     WHERE id = ? AND driver_run_id = ? AND status = 'landed'
       AND COALESCE(review_cycles, 0) = ?`,
  );
  const bumpRun = db.prepare(`UPDATE driver_runs SET updated_at = ? WHERE id = ?`);
  const selectCycle = db.prepare<
    [string, string, number],
    { artifact_id: string; canonical_sha256: string }
  >(
    `SELECT artifact_id, canonical_sha256 FROM driver_review_artifacts
     WHERE driver_run_id = ? AND stream_id = ? AND address_cycle = ?`,
  );
  const selectHeadSha = db.prepare<[string, string, number], { head_sha: string }>(
    `SELECT head_sha FROM driver_review_artifacts
     WHERE driver_run_id = ? AND stream_id = ? AND address_cycle = ?`,
  );
  const selectReceiptFacts = db.prepare<
    [string, string, number],
    {
      artifact_id: string;
      canonical_sha256: string;
      driver_run_id: string;
      stream_id: string;
      repo: string;
      pr_number: number;
      head_sha: string;
      producer_id: string | null;
      producer_harness: string | null;
      producer_catalog_revision: string | null;
      address_cycle: number;
      doc_path: string;
      dispatch_provider: AgentProvider | null;
      dispatch_model: string | null;
    }
  >(
    `SELECT artifact_id, canonical_sha256, driver_run_id, stream_id, repo, pr_number,
            head_sha, producer_id, producer_harness, producer_catalog_revision,
            address_cycle, doc_path, dispatch_provider, dispatch_model
     FROM driver_review_artifacts
     WHERE driver_run_id = ? AND stream_id = ? AND address_cycle = ?`,
  );

  const transaction = db.transaction((input: ConsumeReviewArtifactInput): void => {
    const now = clock();
    let effortDegraded: number | null = null;
    if (input.effortDegraded !== undefined) {
      effortDegraded = input.effortDegraded ? 1 : 0;
    }
    insert.run(
      input.artifactId,
      input.canonicalSha256,
      input.driverRunId,
      input.streamId,
      input.repo,
      input.prNumber,
      input.headSha,
      input.addressCycle,
      input.docPath,
      now,
      input.producerId,
      input.producerHarness,
      input.producerCatalogRevision ?? null,
      input.dispatchProvider,
      input.dispatchModel ?? null,
    );
    const result = updateStream.run(
      JSON.stringify(input.attempts),
      input.addressCycle,
      input.dispatchProvider,
      input.dispatchModel ?? null,
      input.dispatchModelParams === undefined ? null : JSON.stringify(input.dispatchModelParams),
      effortDegraded,
      input.tierDegradeReason ?? null,
      now,
      input.streamId,
      input.driverRunId,
      input.expectedReviewCycle,
    );
    if (result.changes !== 1) {
      throw new ReviewArtifactAddressRacedError(
        `stream ${input.streamId} is no longer landed at review cycle ${String(input.expectedReviewCycle)}`,
      );
    }
    bumpRun.run(now, input.driverRunId);
  });

  return {
    getConsumedHeadSha(driverRunId, streamId, cycle) {
      return selectHeadSha.get(driverRunId, streamId, cycle)?.head_sha;
    },
    getReceiptFacts(driverRunId, streamId, cycle) {
      const row = selectReceiptFacts.get(driverRunId, streamId, cycle);
      if (row === undefined) {
        return undefined;
      }
      if (
        row.producer_id === null ||
        row.producer_harness === null ||
        row.dispatch_provider === null
      ) {
        return undefined;
      }
      return {
        addressCycle: row.address_cycle,
        artifactId: row.artifact_id,
        canonicalSha256: row.canonical_sha256,
        dispatchProvider: row.dispatch_provider,
        docPath: row.doc_path,
        driverRunId: row.driver_run_id,
        headSha: row.head_sha,
        producerHarness: row.producer_harness,
        producerId: row.producer_id,
        prNumber: row.pr_number,
        repo: row.repo,
        streamId: row.stream_id,
        ...(row.dispatch_model === null ? {} : { dispatchModel: row.dispatch_model }),
        ...(row.producer_catalog_revision === null
          ? {}
          : { producerCatalogRevision: row.producer_catalog_revision }),
      };
    },
    consumeAndPrepareDispatch(input) {
      try {
        transaction(input);
      } catch (error: unknown) {
        if (isUniqueConstraint(error)) {
          const winner = selectCycle.get(input.driverRunId, input.streamId, input.addressCycle);
          if (
            winner !== undefined &&
            winner.artifact_id !== input.artifactId &&
            winner.canonical_sha256 !== input.canonicalSha256
          ) {
            throw new ReviewArtifactAddressRacedError(
              `stream ${input.streamId} address cycle ${String(input.addressCycle)} was consumed by a competing artifact`,
            );
          }
          throw new ReviewArtifactDuplicateError("review artifact already consumed", {
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}

function isUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE";
}

import type { AgentProvider } from "@ship/workflow";

import type { Db } from "./db.js";
import type { StreamAttempt } from "./driver-schemas.js";

import { ReviewArtifactAddressRacedError, ReviewArtifactDuplicateError } from "./errors.js";

export interface ConsumeReviewArtifactInput {
  artifactId: string;
  canonicalSha256: string;
  driverRunId: string;
  streamId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  expectedReviewCycle: number;
  addressCycle: number;
  docPath: string;
  attempts: StreamAttempt[];
  dispatchProvider: AgentProvider;
  dispatchModel?: string;
  dispatchModelParams?: { id: string; value: string | boolean }[];
  effortDegraded?: boolean;
  tierDegradeReason?: string;
}

export interface ReviewArtifactOps {
  consumeAndPrepareDispatch: (input: ConsumeReviewArtifactInput) => void;
}

export function createReviewArtifactOps(db: Db, clock: () => string): ReviewArtifactOps {
  const insert = db.prepare(
    `INSERT INTO driver_review_artifacts (
       artifact_id, canonical_sha256, driver_run_id, stream_id, repo, pr_number,
       head_sha, address_cycle, doc_path, consumed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStream = db.prepare(
    `UPDATE driver_streams
     SET attempts = ?, status = 'dispatching', review_cycles = ?,
         work_on_current_branch = 1, dispatch_provider = ?, dispatch_model = ?,
         dispatch_model_params = ?, effort_degraded = ?, tier_degrade_reason = ?,
         updated_at = ?
     WHERE id = ? AND driver_run_id = ? AND status = 'landed'
       AND COALESCE(review_cycles, 0) = ?`,
  );
  const bumpRun = db.prepare(`UPDATE driver_runs SET updated_at = ? WHERE id = ?`);

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
    consumeAndPrepareDispatch(input) {
      try {
        transaction(input);
      } catch (error: unknown) {
        if (isUniqueConstraint(error)) {
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

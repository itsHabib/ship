/**
 * Deterministic merge-gate verdict assembler — policy over recorded ballots.
 * Pure over its inputs; no gh/store/agent calls.
 */

import {
  CANONICAL_REVIEWERS,
  type CanonicalReviewer,
  type MergeVerdict,
  type MergeVerdictEvidence,
  type MergeVerdictInputs,
  REQUIRED_REVIEW_COORDINATOR_CYCLES,
  type ReviewerBallot,
  type ReviewerBallotVerdict,
} from "./types.js";

export { CANONICAL_REVIEWERS, REQUIRED_REVIEW_COORDINATOR_CYCLES } from "./types.js";

/** Assemble one structured merge verdict from gate inputs. */
export function assembleMergeVerdict(inputs: MergeVerdictInputs): MergeVerdict {
  const evidence = buildEvidence(inputs);
  const blockingReasons = collectBlockingReasons(evidence);
  const authorized = blockingReasons.length === 0;
  return {
    authorized,
    blockingReasons,
    evidence,
    outcome: authorized ? "merge_authorized" : "merge_blocked",
  };
}

function buildEvidence(inputs: MergeVerdictInputs): MergeVerdictEvidence {
  return {
    adversarialGatePassed: inputs.adversarialGatePassed,
    ciCheckState: inputs.ciCheckState,
    ciSha: inputs.ciSha,
    requiredReviewCoordinatorCycles: REQUIRED_REVIEW_COORDINATOR_CYCLES,
    reviewCoordinatorCycles: inputs.reviewCoordinatorCycles,
    reviewerBallots: normalizeReviewerBallots(inputs.reviewerBallots),
  };
}

function normalizeReviewerBallots(ballots: ReviewerBallot[]): ReviewerBallot[] {
  const byReviewer = new Map<CanonicalReviewer, ReviewerBallotVerdict>();
  for (const ballot of ballots) {
    byReviewer.set(ballot.reviewer, ballot.verdict);
  }
  return CANONICAL_REVIEWERS.map((reviewer) => ({
    reviewer,
    verdict: byReviewer.get(reviewer) ?? "absent",
  }));
}

function collectBlockingReasons(evidence: MergeVerdictEvidence): string[] {
  const reasons: string[] = [];
  for (const ballot of evidence.reviewerBallots) {
    if (ballot.verdict === "approved") continue;
    reasons.push(formatReviewerBlock(ballot.reviewer, ballot.verdict));
  }
  if (!reviewCyclesGateSatisfied(evidence)) {
    reasons.push(
      `review coordinator cycles ${String(evidence.reviewCoordinatorCycles)}/${String(evidence.requiredReviewCoordinatorCycles)} required`,
    );
  }
  if (!ciGateSatisfied(evidence.ciCheckState)) {
    reasons.push(`CI checks not green (state=${evidence.ciCheckState}, sha=${evidence.ciSha})`);
  }
  if (!evidence.adversarialGatePassed) {
    reasons.push("adversarial gate not passed");
  }
  return reasons;
}

/** Same passing CI states `land.ts` assertReady accepts — success and neutral. */
function ciGateSatisfied(ciCheckState: MergeVerdictEvidence["ciCheckState"]): boolean {
  return ciCheckState === "success" || ciCheckState === "neutral";
}

/**
 * Clean unanimous canonical-reviewer approval skips the coordinator cycle gate
 * (operator policy: a clean pass merges early without three coordinator rounds).
 */
function reviewCyclesGateSatisfied(evidence: MergeVerdictEvidence): boolean {
  const unanimousCleanPass = evidence.reviewerBallots.every(
    (ballot) => ballot.verdict === "approved",
  );
  if (unanimousCleanPass) return true;
  return evidence.reviewCoordinatorCycles >= evidence.requiredReviewCoordinatorCycles;
}

function formatReviewerBlock(reviewer: CanonicalReviewer, verdict: ReviewerBallotVerdict): string {
  if (verdict === "absent") {
    return `reviewer @${reviewer}: missing ballot`;
  }
  return `reviewer @${reviewer}: ${verdict}`;
}

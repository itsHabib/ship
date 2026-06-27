/**
 * Deterministic merge-gate verdict assembler — policy over recorded ballots.
 * Pure over its inputs; no gh/store/agent calls.
 */

import {
  CANONICAL_REVIEWERS,
  type CanonicalReviewer,
  type CiCheckState,
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
  if (!reviewCoordinatorCyclesSatisfied(evidence)) {
    reasons.push(
      `review coordinator cycles ${String(evidence.reviewCoordinatorCycles)}/${String(evidence.requiredReviewCoordinatorCycles)} required`,
    );
  }
  if (!ciStatePassing(evidence.ciCheckState)) {
    reasons.push(`CI checks not green (state=${evidence.ciCheckState}, sha=${evidence.ciSha})`);
  }
  if (!evidence.adversarialGatePassed) {
    reasons.push("adversarial gate not passed");
  }
  return reasons;
}

/** CI states that match `land()` readiness (success + neutral). */
export function ciStatePassing(state: CiCheckState): boolean {
  return state === "success" || state === "neutral";
}

/** Unanimous canonical-reviewer approval satisfies the coordinator cycle gate. */
export function reviewCoordinatorCyclesSatisfied(evidence: MergeVerdictEvidence): boolean {
  if (evidence.reviewCoordinatorCycles >= evidence.requiredReviewCoordinatorCycles) {
    return true;
  }
  return unanimousCanonicalApproval(evidence.reviewerBallots);
}

function unanimousCanonicalApproval(ballots: ReviewerBallot[]): boolean {
  if (ballots.length !== CANONICAL_REVIEWERS.length) return false;
  return ballots.every((ballot) => ballot.verdict === "approved");
}

function formatReviewerBlock(reviewer: CanonicalReviewer, verdict: ReviewerBallotVerdict): string {
  if (verdict === "absent") {
    return `reviewer @${reviewer}: missing ballot`;
  }
  return `reviewer @${reviewer}: ${verdict}`;
}

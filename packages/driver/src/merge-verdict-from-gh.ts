/**
 * Map real gh readiness + review facts into MergeVerdictInputs for land().
 */

import type { GhPrCheck, GhPrReadiness, GhReviewEntry } from "./gh-port.js";
import type {
  CanonicalReviewer,
  CiCheckState,
  MergeVerdict,
  MergeVerdictInputs,
  ReviewerBallot,
  ReviewerBallotVerdict,
} from "./types.js";

import { assembleMergeVerdict, CANONICAL_REVIEWERS } from "./merge-verdict.js";

/** Conclusions that count as a passing terminal check — mirrors land.ts. */
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

const REVIEWER_LOGIN_PATTERNS: Record<CanonicalReviewer, RegExp> = {
  claude: /claude/i,
  codex: /codex/i,
  cursor: /copilot|cursor/i,
};

export interface AssembleMergeVerdictFromGhInput {
  adversarialGatePassed?: boolean;
  ciSha: string;
  readiness: GhPrReadiness;
  reviewCoordinatorCycles: number;
  reviews: GhReviewEntry[];
}

/** Derive terminal CI rollup state from a PR readiness snapshot. */
export function ciCheckStateFromReadiness(readiness: GhPrReadiness): CiCheckState {
  for (const check of readiness.checks) {
    if (isNonTerminalCheck(check)) return "pending";
  }
  for (const check of readiness.checks) {
    if (isFailingCheck(check)) return "failure";
  }
  const terminalChecks = readiness.checks.filter(isTerminalCheck);
  if (terminalChecks.length === 0) return "success";
  const allNeutralOrSkipped = terminalChecks.every(
    (check) => check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED",
  );
  if (allNeutralOrSkipped && terminalChecks.some((check) => check.conclusion === "NEUTRAL")) {
    return "neutral";
  }
  return "success";
}

/** Build reviewer ballots from gh review entries (latest per canonical reviewer). */
export function reviewerBallotsFromReviews(reviews: GhReviewEntry[]): ReviewerBallot[] {
  const byReviewer = new Map<CanonicalReviewer, ReviewerBallotVerdict>();
  for (const review of reviews) {
    const reviewer = canonicalReviewerForLogin(review.authorLogin);
    if (reviewer === undefined) continue;
    byReviewer.set(reviewer, mapReviewState(review.state));
  }
  return CANONICAL_REVIEWERS.map((reviewer) => ({
    reviewer,
    verdict: byReviewer.get(reviewer) ?? "absent",
  }));
}

/** Assemble a structured merge verdict from gh-derived gate inputs. */
export function assembleMergeVerdictFromGh(input: AssembleMergeVerdictFromGhInput): MergeVerdict {
  const verdictInputs: MergeVerdictInputs = {
    adversarialGatePassed: input.adversarialGatePassed ?? true,
    ciCheckState: ciCheckStateFromReadiness(input.readiness),
    ciSha: input.ciSha,
    reviewCoordinatorCycles: input.reviewCoordinatorCycles,
    reviewerBallots: reviewerBallotsFromReviews(input.reviews),
  };
  return assembleMergeVerdict(verdictInputs);
}

function canonicalReviewerForLogin(login: string): CanonicalReviewer | undefined {
  for (const reviewer of CANONICAL_REVIEWERS) {
    if (REVIEWER_LOGIN_PATTERNS[reviewer].test(login)) return reviewer;
  }
  return undefined;
}

function mapReviewState(state: string): ReviewerBallotVerdict {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes_requested";
  if (state === "COMMENTED" || state === "PENDING") return "pending";
  return "absent";
}

function isTerminalCheck(check: GhPrCheck): boolean {
  return check.status === "COMPLETED" && check.conclusion !== "";
}

function isNonTerminalCheck(check: GhPrCheck): boolean {
  return !isTerminalCheck(check);
}

function isFailingCheck(check: GhPrCheck): boolean {
  return isTerminalCheck(check) && !PASSING_CONCLUSIONS.has(check.conclusion);
}

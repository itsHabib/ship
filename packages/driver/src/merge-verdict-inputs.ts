/**
 * Map GitHub PR facts into MergeVerdictInputs — policy layer over gh mechanism.
 */

import type { GhPrCheck, GhPrReview } from "./gh-port.js";
import type {
  CanonicalReviewer,
  CiCheckState,
  MergeVerdictInputs,
  ReviewerBallot,
  ReviewerBallotVerdict,
} from "./types.js";

import { CANONICAL_REVIEWERS } from "./merge-verdict.js";

/** Conclusions that count as passing — mirrors `land()` readiness guard. */
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

export interface BuildMergeVerdictInputsOpts {
  headSha: string;
  checks: GhPrCheck[];
  reviews: GhPrReview[];
  /** Stream-recorded review cycles when present. */
  streamCycles?: number;
  adversarialGatePassed?: boolean;
}

/** Build merge-gate inputs from gh-fetched PR context. */
export function buildMergeVerdictInputs(opts: BuildMergeVerdictInputsOpts): MergeVerdictInputs {
  const { ciCheckState, ciSha } = deriveCiCheckState(opts.checks, opts.headSha);
  return {
    adversarialGatePassed: opts.adversarialGatePassed ?? true,
    ciCheckState,
    ciSha,
    reviewCoordinatorCycles: opts.streamCycles ?? countReviewRounds(opts.reviews),
    reviewerBallots: mapReviewerBallots(opts.reviews),
  };
}

function deriveCiCheckState(
  checks: GhPrCheck[],
  headSha: string,
): { ciCheckState: CiCheckState; ciSha: string } {
  const failing = checks.filter(isFailingCheck);
  if (failing.length > 0) {
    return { ciCheckState: "failure", ciSha: headSha };
  }
  const running = checks.filter(isNonTerminalCheck);
  if (running.length > 0) {
    return { ciCheckState: "pending", ciSha: headSha };
  }
  const terminal = checks.filter(isTerminalCheck);
  if (terminal.length === 0) {
    return { ciCheckState: "success", ciSha: headSha };
  }
  const hasSuccess = terminal.some((check) => check.conclusion === "SUCCESS");
  if (hasSuccess) {
    return { ciCheckState: "success", ciSha: headSha };
  }
  const allNeutralOrSkipped = terminal.every(
    (check) => check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED",
  );
  if (allNeutralOrSkipped) {
    return { ciCheckState: "neutral", ciSha: headSha };
  }
  return { ciCheckState: "success", ciSha: headSha };
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

/** Latest ballot per canonical reviewer from gh review rows. */
export function mapReviewerBallots(reviews: GhPrReview[]): ReviewerBallot[] {
  const byReviewer = new Map<CanonicalReviewer, ReviewerBallotVerdict>();
  for (const review of reviews) {
    const reviewer = matchCanonicalReviewer(review.authorLogin);
    if (reviewer === undefined) continue;
    byReviewer.set(reviewer, mapReviewState(review.state));
  }
  return CANONICAL_REVIEWERS.map((reviewer) => ({
    reviewer,
    verdict: byReviewer.get(reviewer) ?? "absent",
  }));
}

function matchCanonicalReviewer(login: string): CanonicalReviewer | undefined {
  const normalized = login.toLowerCase();
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("copilot") || normalized.includes("cursor")) return "cursor";
  return undefined;
}

function mapReviewState(state: string): ReviewerBallotVerdict {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes_requested";
  if (state === "PENDING" || state === "COMMENTED") return "pending";
  return "absent";
}

/** Count review rounds from CHANGES_REQUESTED cycles in gh history. */
export function countReviewRounds(reviews: GhPrReview[]): number {
  const changesRequested = reviews.filter((review) => review.state === "CHANGES_REQUESTED").length;
  if (changesRequested === 0) return 0;
  return changesRequested;
}

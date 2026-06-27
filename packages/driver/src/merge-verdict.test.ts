/** Unit tests for the merge-gate verdict assembler. */

import { describe, expect, test } from "vitest";

import type { MergeVerdictInputs, ReviewerBallot } from "./types.js";

import {
  assembleMergeVerdict,
  CANONICAL_REVIEWERS,
  REQUIRED_REVIEW_COORDINATOR_CYCLES,
} from "./merge-verdict.js";

function allApprovedBallots(): ReviewerBallot[] {
  return CANONICAL_REVIEWERS.map((reviewer) => ({
    reviewer,
    verdict: "approved" as const,
  }));
}

function authorizedInputs(overrides: Partial<MergeVerdictInputs> = {}): MergeVerdictInputs {
  return {
    adversarialGatePassed: true,
    ciCheckState: "success",
    ciSha: "abc123def456",
    reviewCoordinatorCycles: REQUIRED_REVIEW_COORDINATOR_CYCLES,
    reviewerBallots: allApprovedBallots(),
    ...overrides,
  };
}

describe("assembleMergeVerdict", () => {
  test("all-approve + green CI + adversarial-pass + required cycles → authorized", () => {
    const verdict = assembleMergeVerdict(authorizedInputs());

    expect(verdict.outcome).toBe("merge_authorized");
    expect(verdict.authorized).toBe(true);
    expect(verdict.blockingReasons).toEqual([]);
    expect(verdict.evidence.reviewerBallots).toEqual(allApprovedBallots());
    expect(verdict.evidence.requiredReviewCoordinatorCycles).toBe(
      REQUIRED_REVIEW_COORDINATOR_CYCLES,
    );
  });

  test("missing reviewer ballot → not authorized with blocking reason", () => {
    const verdict = assembleMergeVerdict(
      authorizedInputs({
        reviewerBallots: [
          { reviewer: "codex", verdict: "approved" },
          { reviewer: "claude", verdict: "approved" },
        ],
      }),
    );

    expect(verdict.outcome).toBe("merge_blocked");
    expect(verdict.authorized).toBe(false);
    expect(verdict.blockingReasons).toContain("reviewer @cursor: missing ballot");
  });

  test("red CI → not authorized with CI blocking reason", () => {
    const verdict = assembleMergeVerdict(
      authorizedInputs({
        ciCheckState: "failure",
        ciSha: "deadbeef",
      }),
    );

    expect(verdict.authorized).toBe(false);
    expect(verdict.blockingReasons).toContain("CI checks not green (state=failure, sha=deadbeef)");
  });

  test("failed adversarial gate → not authorized", () => {
    const verdict = assembleMergeVerdict(
      authorizedInputs({
        adversarialGatePassed: false,
      }),
    );

    expect(verdict.authorized).toBe(false);
    expect(verdict.blockingReasons).toContain("adversarial gate not passed");
  });

  test("insufficient review-coordinator cycles → not authorized", () => {
    const verdict = assembleMergeVerdict(
      authorizedInputs({
        reviewCoordinatorCycles: REQUIRED_REVIEW_COORDINATOR_CYCLES - 1,
        reviewerBallots: [
          { reviewer: "codex", verdict: "approved" },
          { reviewer: "claude", verdict: "pending" },
          { reviewer: "cursor", verdict: "approved" },
        ],
      }),
    );

    expect(verdict.authorized).toBe(false);
    expect(verdict.blockingReasons).toContain(
      `review coordinator cycles ${String(REQUIRED_REVIEW_COORDINATOR_CYCLES - 1)}/${String(REQUIRED_REVIEW_COORDINATOR_CYCLES)} required`,
    );
  });

  test("unanimous clean pass authorizes without coordinator cycles", () => {
    const verdict = assembleMergeVerdict(
      authorizedInputs({
        reviewCoordinatorCycles: 0,
      }),
    );

    expect(verdict.outcome).toBe("merge_authorized");
    expect(verdict.authorized).toBe(true);
  });

  test("neutral CI authorizes like success", () => {
    const verdict = assembleMergeVerdict(
      authorizedInputs({
        ciCheckState: "neutral",
      }),
    );

    expect(verdict.outcome).toBe("merge_authorized");
    expect(verdict.authorized).toBe(true);
  });

  test("changes_requested reviewer → not authorized with verdict surfaced", () => {
    const verdict = assembleMergeVerdict(
      authorizedInputs({
        reviewerBallots: [
          { reviewer: "codex", verdict: "approved" },
          { reviewer: "claude", verdict: "changes_requested" },
          { reviewer: "cursor", verdict: "approved" },
        ],
      }),
    );

    expect(verdict.authorized).toBe(false);
    expect(verdict.blockingReasons).toContain("reviewer @claude: changes_requested");
  });

  test("same inputs → identical verdict (determinism)", () => {
    const inputs = authorizedInputs({
      reviewCoordinatorCycles: 2,
      reviewerBallots: [{ reviewer: "codex", verdict: "pending" }],
    });
    const first = assembleMergeVerdict(inputs);
    const second = assembleMergeVerdict(inputs);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

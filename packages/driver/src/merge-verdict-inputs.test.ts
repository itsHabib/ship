/** MergeVerdictInputs builder from gh facts. */

import { describe, expect, test } from "vitest";

import { buildMergeVerdictInputs, mapReviewerBallots } from "./merge-verdict-inputs.js";
import { assembleMergeVerdict, REQUIRED_REVIEW_COORDINATOR_CYCLES } from "./merge-verdict.js";

describe("buildMergeVerdictInputs", () => {
  test("maps neutral-only checks to neutral ciCheckState", () => {
    const inputs = buildMergeVerdictInputs({
      checks: [{ conclusion: "NEUTRAL", name: "advisory", status: "COMPLETED" }],
      headSha: "sha1",
      reviews: [],
    });

    expect(inputs.ciCheckState).toBe("neutral");
  });

  test("unanimous reviewer approval authorizes without coordinator cycles", () => {
    const reviews = [
      { authorLogin: "chatgpt-codex-connector", state: "APPROVED" },
      { authorLogin: "claude-bot", state: "APPROVED" },
      { authorLogin: "copilot-pull-request-reviewer", state: "APPROVED" },
    ];
    const inputs = buildMergeVerdictInputs({
      checks: [{ conclusion: "SUCCESS", name: "ci", status: "COMPLETED" }],
      headSha: "sha2",
      reviews,
      streamCycles: 0,
    });

    const verdict = assembleMergeVerdict(inputs);
    expect(verdict.outcome).toBe("merge_authorized");
    expect(inputs.reviewCoordinatorCycles).toBe(0);
    expect(verdict.evidence.requiredReviewCoordinatorCycles).toBe(
      REQUIRED_REVIEW_COORDINATOR_CYCLES,
    );
  });
});

describe("mapReviewerBallots", () => {
  test("fills absent for missing canonical reviewers", () => {
    const ballots = mapReviewerBallots([{ authorLogin: "codex", state: "APPROVED" }]);
    expect(ballots.find((b) => b.reviewer === "codex")?.verdict).toBe("approved");
    expect(ballots.find((b) => b.reviewer === "claude")?.verdict).toBe("absent");
  });
});

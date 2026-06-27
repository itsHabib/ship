/** Unit tests for gh → merge-verdict input mapping. */

import { describe, expect, test } from "vitest";

import type { GhPrReadiness } from "./gh-port.js";

import { assembleMergeVerdictFromGh, ciCheckStateFromReadiness } from "./merge-verdict-from-gh.js";

describe("ciCheckStateFromReadiness", () => {
  test("maps neutral-only passing checks to neutral", () => {
    const readiness: GhPrReadiness = {
      checks: [{ conclusion: "NEUTRAL", name: "advisory", status: "COMPLETED" }],
      isDraft: false,
      mergeable: "MERGEABLE",
      state: "OPEN",
    };

    expect(ciCheckStateFromReadiness(readiness)).toBe("neutral");
  });

  test("maps failing checks to failure", () => {
    const readiness: GhPrReadiness = {
      checks: [{ conclusion: "FAILURE", name: "test", status: "COMPLETED" }],
      isDraft: false,
      mergeable: "MERGEABLE",
      state: "OPEN",
    };

    expect(ciCheckStateFromReadiness(readiness)).toBe("failure");
  });
});

describe("assembleMergeVerdictFromGh", () => {
  test("unanimous gh reviews authorize without coordinator cycles", () => {
    const verdict = assembleMergeVerdictFromGh({
      ciSha: "abc123",
      readiness: {
        checks: [{ conclusion: "NEUTRAL", name: "advisory", status: "COMPLETED" }],
        isDraft: false,
        mergeable: "MERGEABLE",
        state: "OPEN",
      },
      reviewCoordinatorCycles: 0,
      reviews: [
        { authorLogin: "codex-bot", state: "APPROVED" },
        { authorLogin: "claude-bot", state: "APPROVED" },
        { authorLogin: "copilot-pull-request-reviewer", state: "APPROVED" },
      ],
    });

    expect(verdict.outcome).toBe("merge_authorized");
  });
});

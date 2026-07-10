import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import {
  canonicalReviewFindingsSha256,
  parseReviewFindings,
  ReviewFindingsValidationError,
} from "./review-findings.js";

const HEAD = "a".repeat(40);

function artifact(artifactId = "rf_one", generatedAt = "2026-07-10T00:00:00Z") {
  return {
    schema_version: 1,
    artifact_id: artifactId,
    decision: "address",
    subject: { type: "pull_request", repo: "example/ship", number: 7, head_sha: HEAD },
    producer: { id: "review-coordinator", harness: "codex", generated_at: generatedAt },
    panel: {
      requested: ["codex", "claude"],
      completed: ["codex", "claude"],
      missing: [] as string[],
    },
    findings: [
      {
        id: "b",
        severity: "suggestion",
        summary: "second",
        evidence: "second evidence",
        sources: [
          {
            reviewer: "claude",
            comment_id: "2",
            url: "https://github.com/example/ship/pull/7#discussion_r2",
          },
        ],
      },
      {
        id: "a",
        severity: "P1",
        summary: "first",
        evidence: "first evidence",
        sources: [
          {
            reviewer: "codex",
            comment_id: "1",
            url: "https://github.com/example/ship/pull/7#discussion_r1",
          },
        ],
      },
    ],
  };
}

describe("ReviewFindingsV1", () => {
  test("accepts opaque severity and strips compatible extension fields", () => {
    const input = {
      ...artifact(),
      receipt: { trace: "ignored" },
      findings: artifact().findings.map((finding) => ({ ...finding, confidence: 0.9 })),
    };

    const parsed = parseReviewFindings(JSON.stringify(input));

    expect(parsed.findings[0]?.severity).toBe("suggestion");
    expect(parsed).not.toHaveProperty("receipt");
    expect(parsed.findings[0]).not.toHaveProperty("confidence");
  });

  test("refuses a mixed-validity source and malformed panel partition", () => {
    const mixed = artifact();
    mixed.findings[0]!.sources.push({
      reviewer: "copilot",
      comment_id: "3",
      url: "https://github.com/example/ship/pull/7#discussion_r3",
    });
    expect(() => parseReviewFindings(JSON.stringify(mixed))).toThrow(ReviewFindingsValidationError);

    const extra = artifact();
    extra.panel.completed.push("copilot");
    expect(() => parseReviewFindings(JSON.stringify(extra))).toThrow(ReviewFindingsValidationError);
  });

  fcTest.prop(
    [
      fc.uuid(),
      fc.date({
        min: new Date("2000-01-01T00:00:00Z"),
        max: new Date("2100-01-01T00:00:00Z"),
        noInvalidDate: true,
      }),
    ],
    { numRuns: 100 },
  )(
    "canonical digest ignores envelope metadata, extensions, and set ordering",
    (artifactId, generatedAt) => {
      const original = parseReviewFindings(JSON.stringify(artifact()));
      const replayBase = artifact(artifactId, generatedAt.toISOString());
      const replay = {
        ...replayBase,
        receipt: { delivery: artifactId },
        panel: {
          requested: [...replayBase.panel.requested].reverse(),
          completed: [...replayBase.panel.completed].reverse(),
          missing: replayBase.panel.missing,
        },
        findings: [...replayBase.findings].reverse().map((finding) => ({
          ...finding,
          ignored: true,
          sources: [...finding.sources].reverse().map((source) => ({ ...source, confidence: 1 })),
        })),
      };

      expect(canonicalReviewFindingsSha256(parseReviewFindings(JSON.stringify(replay)))).toBe(
        canonicalReviewFindingsSha256(original),
      );
    },
  );

  fcTest.prop([fc.constantFrom(" ", "\t", "\r\n", "  \t  ")], { numRuns: 100 })(
    "whitespace-only evidence never parses",
    (blank) => {
      const input = artifact();
      input.findings[0]!.evidence = blank;
      expect(() => parseReviewFindings(JSON.stringify(input))).toThrow(
        ReviewFindingsValidationError,
      );
    },
  );
});

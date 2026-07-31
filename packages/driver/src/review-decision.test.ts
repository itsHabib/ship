import { describe, expect, test } from "vitest";

import {
  assertReviewDecisionAuthorizes,
  parseReviewDecision,
  ReviewDecisionValidationError,
} from "./review-decision.js";
import { parseReviewFindings } from "./review-findings.js";

const HEAD = "a".repeat(40);

describe("ReviewDecisionV1", () => {
  test("authorizes only the exact accepted finding set and cycle", () => {
    const decision = parseReviewDecision(JSON.stringify(decisionValue()));
    const findings = parseReviewFindings(JSON.stringify(findingsValue()));
    expect(() => {
      assertReviewDecisionAuthorizes(decision, findings, 1);
    }).not.toThrow();
  });

  test.each([
    ["wrong action", { action: "stop" }],
    ["wrong head", { subject: { ...decisionValue().subject, head_sha: "b".repeat(40) } }],
    ["wrong cycle", { cycle: 2, continuation_weight: 2, cumulative_weight: 3 }],
    [
      "wrong finding",
      {
        findings: [
          {
            ...decisionValue().findings[0],
            id: "other",
          },
        ],
      },
    ],
  ])("rejects %s", (_name, over) => {
    const decision = parseReviewDecision(JSON.stringify({ ...decisionValue(), ...over }));
    const findings = parseReviewFindings(JSON.stringify(findingsValue()));
    expect(() => {
      assertReviewDecisionAuthorizes(decision, findings, 1);
    }).toThrow(ReviewDecisionValidationError);
  });

  test("rejects forged continuation weights", () => {
    expect(() =>
      parseReviewDecision(JSON.stringify({ ...decisionValue(), continuation_weight: 8 })),
    ).toThrow(/continuation weights/u);
  });

  test.each(["deliberately_overridden", "full_panel_fallback", "parked_unverified"] as const)(
    "accepts the portable %s route disposition",
    (routeDisposition) => {
      expect(() =>
        parseReviewDecision(
          JSON.stringify({
            ...decisionValue(),
            route_disposition: routeDisposition,
            route_reason: "explicit safe route",
          }),
        ),
      ).not.toThrow();
    },
  );

  test("rejects unknown fields instead of silently stripping schema drift", () => {
    expect(() =>
      parseReviewDecision(JSON.stringify({ ...decisionValue(), unexpected: true })),
    ).toThrow(ReviewDecisionValidationError);
  });

  test.each([
    ["deferred finding without rationale", { disposition: "deferred", defer_reason: undefined }],
    ["debt finding without follow-up", { debt: true, follow_up_ref: undefined }],
  ])("rejects %s", (_name, findingPatch) => {
    const value = decisionValue();
    const finding = { ...value.findings[0], ...findingPatch };
    expect(() => parseReviewDecision(JSON.stringify({ ...value, findings: [finding] }))).toThrow(
      ReviewDecisionValidationError,
    );
  });
});

function decisionValue() {
  return {
    schema_version: 1,
    generated_at: "2026-07-30T00:00:00Z",
    subject: { repo: "example/ship", number: 77, head_sha: HEAD },
    plan_id: `rp_${"1".repeat(32)}`,
    input_digest: `sha256:${"2".repeat(64)}`,
    policy: { id: "tier-aware-canary", digest: `sha256:${"a".repeat(64)}` },
    route_disposition: "tier_routed",
    tier: "T1",
    tier_reasons: ["diff floor T1"],
    cycle: 1,
    continuation_weight: 1,
    cumulative_weight: 1,
    action: "address",
    reason_codes: ["accepted_findings_require_address"],
    next_reviewers: ["codex"],
    findings: [
      {
        id: "finding-1",
        severity: "high",
        reviewers: ["codex"],
        disposition: "fixed",
        changed: false,
        reviewer_closed: false,
        debt: false,
      },
    ],
  };
}

function findingsValue() {
  return {
    schema_version: 1,
    artifact_id: "rf_test",
    decision: "address",
    subject: {
      type: "pull_request",
      repo: "example/ship",
      number: 77,
      head_sha: HEAD,
    },
    producer: {
      id: "review-coordinator",
      harness: "test",
      generated_at: "2026-07-30T00:00:00Z",
    },
    panel: { requested: ["codex"], completed: ["codex"], missing: [] },
    findings: [
      {
        id: "finding-1",
        severity: "high",
        summary: "fix it",
        evidence: "evidence",
        sources: [
          {
            reviewer: "codex",
            comment_id: "1",
            url: "https://example.test/comments/1",
          },
        ],
      },
    ],
  };
}

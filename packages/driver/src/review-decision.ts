import { z } from "zod";

import type { ReviewFindingsV1 } from "./review-findings.js";

export const MAX_REVIEW_DECISION_BYTES = 1024 * 1024;

const bounded = z.string().trim().min(1);
const subjectSchema = z
  .object({
    repo: bounded.regex(/^[^/\s]+\/[^/\s]+$/u).transform((value) => value.toLowerCase()),
    number: z.number().int().positive(),
    head_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/iu)
      .transform((value) => value.toLowerCase()),
  })
  .strict();

const findingSchema = z
  .object({
    id: bounded,
    severity: bounded,
    reviewers: z.array(bounded).min(1),
    disposition: z.enum(["fixed", "proved_safe", "deferred", "unresolved"]),
    changed: z.boolean(),
    reviewer_closed: z.boolean(),
    proof_ref: z.string().optional(),
    defer_reason: z.string().optional(),
    debt: z.boolean(),
    follow_up_ref: z.string().optional(),
  })
  .strict();

const policySchema = z
  .object({
    id: bounded,
    // Workbench computes policy digests from canonical content and emits
    // lowercase hex; accepting another representation would break identity.
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();

const decisionSchema = z
  .object({
    schema_version: z.literal(1),
    generated_at: z.string().datetime({ offset: true }),
    subject: subjectSchema,
    plan_id: z.string().regex(/^rp_[0-9a-f]{32}$/u),
    input_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    policy: policySchema.optional(),
    route_disposition: z.enum([
      "tier_routed",
      "deliberately_overridden",
      "full_panel_fallback",
      "parked_unverified",
    ]),
    route_reason: z.string().trim().min(1).optional(),
    tier: z.enum(["T0", "T1", "T2", "T3"]).optional(),
    tier_reasons: z.array(bounded).optional(),
    cycle: z.number().int().min(1).max(8),
    continuation_weight: z.number().int().positive(),
    cumulative_weight: z.number().int().positive(),
    action: z.enum(["stop", "continue", "address", "escalate", "park"]),
    reason_codes: z.array(bounded).min(1),
    next_reviewers: z.array(bounded),
    findings: z.array(findingSchema),
  })
  .strict();

export type ReviewDecisionV1 = z.infer<typeof decisionSchema>;

export class ReviewDecisionValidationError extends Error {
  override readonly name = "ReviewDecisionValidationError";
}

export function parseReviewDecision(input: string): ReviewDecisionV1 {
  const decision = decodeReviewDecision(input);
  validateDecisionCollections(decision);
  validateDecisionWeights(decision);
  validateDecisionRoute(decision);
  return decision;
}

function decodeReviewDecision(input: string): ReviewDecisionV1 {
  if (Buffer.byteLength(input, "utf8") > MAX_REVIEW_DECISION_BYTES) {
    throw new ReviewDecisionValidationError("review decision exceeds 1 MiB");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch (cause: unknown) {
    throw new ReviewDecisionValidationError("review decision is not valid JSON", { cause });
  }
  const parsed = decisionSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ReviewDecisionValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

function validateDecisionCollections(decision: ReviewDecisionV1): void {
  assertUnique("decision reason codes", decision.reason_codes);
  assertUnique("decision next reviewers", decision.next_reviewers);
  assertUnique("decision tier reasons", decision.tier_reasons ?? []);
  assertUnique(
    "decision finding ids",
    decision.findings.map((finding) => finding.id),
  );
  for (const finding of decision.findings) {
    validateDecisionFinding(finding);
  }
}

function validateDecisionFinding(finding: ReviewDecisionV1["findings"][number]): void {
  assertUnique(`decision finding ${finding.id} reviewers`, finding.reviewers);
  if (finding.disposition === "deferred" && !finding.defer_reason?.trim()) {
    throw new ReviewDecisionValidationError(
      `deferred decision finding ${finding.id} requires defer_reason`,
    );
  }
  validateProvedSafeFinding(finding);
  if (finding.debt && !finding.follow_up_ref?.trim()) {
    throw new ReviewDecisionValidationError(
      `debt decision finding ${finding.id} requires follow_up_ref`,
    );
  }
}

function validateProvedSafeFinding(finding: ReviewDecisionV1["findings"][number]): void {
  if (
    finding.disposition === "proved_safe" &&
    !finding.reviewer_closed &&
    !finding.proof_ref?.trim()
  ) {
    throw new ReviewDecisionValidationError(
      `proved_safe decision finding ${finding.id} requires reviewer_closed or proof_ref`,
    );
  }
}

function validateDecisionWeights(decision: ReviewDecisionV1): void {
  const continuation = 2 ** (decision.cycle - 1);
  const cumulative = 2 ** decision.cycle - 1;
  if (decision.continuation_weight !== continuation || decision.cumulative_weight !== cumulative) {
    throw new ReviewDecisionValidationError("review decision continuation weights are invalid");
  }
}

function validateDecisionRoute(decision: ReviewDecisionV1): void {
  if (decision.route_disposition !== "tier_routed" && decision.route_reason === undefined) {
    throw new ReviewDecisionValidationError("non-routed review decision requires route_reason");
  }
  if (
    decision.route_disposition === "tier_routed" &&
    (decision.policy === undefined || decision.tier === undefined)
  ) {
    throw new ReviewDecisionValidationError("tier-routed review decision requires policy and tier");
  }
}

export function assertReviewDecisionAuthorizes(
  decision: ReviewDecisionV1,
  artifact: ReviewFindingsV1,
  cycle: number,
): void {
  if (decision.action !== "address") {
    throw new ReviewDecisionValidationError(
      `review decision action ${decision.action} does not authorize address`,
    );
  }
  if (
    decision.subject.repo !== artifact.subject.repo ||
    decision.subject.number !== artifact.subject.number ||
    decision.subject.head_sha !== artifact.subject.head_sha
  ) {
    throw new ReviewDecisionValidationError(
      "review decision subject does not match findings artifact",
    );
  }
  if (decision.cycle !== cycle) {
    throw new ReviewDecisionValidationError(
      `review decision cycle ${String(decision.cycle)} does not match address cycle ${String(cycle)}`,
    );
  }
  // The findings artifact is the address worklist, not the complete panel
  // ledger. Only accepted, not-yet-executed fixes belong in that worklist;
  // proved-safe, deferred, unresolved, and already-changed findings remain in
  // the decision for audit but must not be dispatched as implementation work.
  const accepted = new Set(
    decision.findings
      .filter((finding) => finding.disposition === "fixed" && !finding.changed)
      .map((finding) => finding.id),
  );
  const artifactIDs = new Set(artifact.findings.map((finding) => finding.id));
  if (accepted.size === 0 || !sameSet(accepted, artifactIDs)) {
    throw new ReviewDecisionValidationError(
      "review decision accepted finding ids do not match findings artifact",
    );
  }
}

function assertUnique(name: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new ReviewDecisionValidationError(`${name} must be unique`);
  }
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

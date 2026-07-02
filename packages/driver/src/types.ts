/**
 * Public types for `@ship/driver` engine surface (spec §6).
 */

import type { ShipInput } from "@ship/core";
import type { DriverRun, DriverRunStatus, DriverStream } from "@ship/store";
import type { AgentProvider, FailureCategory } from "@ship/workflow";

import type { EffortTier, ModelTier } from "./manifest.js";

export interface TierDegrade {
  modelDegraded?: boolean;
  effortDegraded?: boolean;
  reason?: string;
}

/** Result of mapping manifest tiers to concrete `ShipInput` model fields. */
export interface TierDispatchResult {
  model?: string;
  modelParams?: NonNullable<ShipInput["modelParams"]>;
  degrade?: TierDegrade;
}

export type DriverRunRef = { driverRunId: string } | { manifestPath: string };

export interface RunOpts {
  batch?: number;
  /** Inactivity window (monotonic last-event-age) before the tick gives up. Default 20 min. */
  maxWaitMs?: number;
  /** Absolute monotonic ceiling for a tick; overrides the derived default when set. */
  runawayBackstopMs?: number;
  pollIntervalMs?: number;
  maxParallel?: { local?: number; cloud?: number };
  force?: boolean;
}

export type Decision =
  | { kind: "retry" }
  | { kind: "skip"; reason: string }
  | { kind: "abort"; reason: string }
  | { kind: "adopt"; workflowRunId: string };

export interface MergeFacts {
  prNumber: number;
  mergeCommit: string;
  mergedAt?: string;
  cycles?: number;
}

export interface LandOpts {
  prNumber: number;
  streamId?: string;
  cycles?: number;
  /** Pass `--admin` to the merge (bypass branch protection). Default false. */
  admin?: boolean;
}

export interface DriverStreamView {
  streamId: string;
  batchIndex: number;
  taskSlug?: string;
  specPath: string;
  branch?: string;
  runtime: DriverStream["runtime"];
  status: DriverStream["status"];
  workflowRunId?: string;
  prUrl?: string;
  modelTier?: ModelTier;
  effortTier?: EffortTier;
  provider?: AgentProvider;
  dispatchProvider?: AgentProvider;
  dispatchModel?: string;
  dispatchModelParams?: NonNullable<ShipInput["modelParams"]>;
  effortDegraded?: boolean;
  tierDegradeReason?: string;
}

/** Canonical external reviewers polled before merge authorization. */
export const CANONICAL_REVIEWERS = ["codex", "claude", "cursor"] as const;
export type CanonicalReviewer = (typeof CANONICAL_REVIEWERS)[number];

export type ReviewerBallotVerdict = "approved" | "changes_requested" | "pending" | "absent";

export interface ReviewerBallot {
  reviewer: CanonicalReviewer;
  verdict: ReviewerBallotVerdict;
}

/** Terminal CI rollup state for the merge-gate sha under review. */
export type CiCheckState = "success" | "failure" | "pending" | "neutral";

/** Minimum `/review-coordinator` ballot count before merge authorization. */
export const REQUIRED_REVIEW_COORDINATOR_CYCLES = 3;

export interface MergeVerdictEvidence {
  reviewerBallots: ReviewerBallot[];
  reviewCoordinatorCycles: number;
  requiredReviewCoordinatorCycles: number;
  ciSha: string;
  ciCheckState: CiCheckState;
  adversarialGatePassed: boolean;
}

export type MergeVerdictOutcome = "merge_authorized" | "merge_blocked";

/** Structured merge-gate authorization with attached evidence. */
export interface MergeVerdict {
  outcome: MergeVerdictOutcome;
  authorized: boolean;
  blockingReasons: string[];
  evidence: MergeVerdictEvidence;
}

export interface MergeVerdictInputs {
  reviewerBallots: ReviewerBallot[];
  reviewCoordinatorCycles: number;
  ciSha: string;
  ciCheckState: CiCheckState;
  adversarialGatePassed: boolean;
}

export type JudgmentRequest =
  | {
      kind: "failure-triage";
      driverRunId: string;
      streamId: string;
      /** Absent for dispatch-time failures — no workflow ever started. */
      workflowRunId?: string;
      failureCategory: FailureCategory;
      errorMessage?: string;
      attempts: number;
      hint?: string;
    }
  | {
      kind: "dispatch-ambiguity";
      driverRunId: string;
      streamId: string;
      candidates: { workflowRunId: string; createdAt: string; status: string }[];
    }
  | {
      kind: "merge-confirmation";
      driverRunId: string;
      streamId: string;
      prNumber: number;
      verdict: MergeVerdict;
    }
  | {
      kind: "review-adjudication";
      driverRunId: string;
      streamId: string;
      prNumber: number;
      verdict: MergeVerdict;
    };

export interface DriverTickResult {
  driverRunId: string;
  status: "running" | "awaiting_judgment" | "blocked_on_merges" | "done" | "failed" | "cancelled";
  awaiting: JudgmentRequest[];
  unmerged: DriverStreamView[];
  progress: {
    batchIndex: number;
    dispatched: number;
    landed: number;
    failed: number;
    remaining: number;
  };
  streams: DriverStreamView[];
  /** Populated only when this tick auto-imported a manifest with ignored unknown keys. */
  warnings?: string[];
}

export type { DriverRun, DriverRunStatus };

/**
 * Public types for `@ship/driver` engine surface (spec §6).
 */

import type { DriverRun, DriverRunStatus, DriverStream } from "@ship/store";
import type { FailureCategory } from "@ship/workflow";

export type DriverRunRef = { driverRunId: string } | { manifestPath: string };

export interface RunOpts {
  batch?: number;
  maxWaitMs?: number;
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
  | { kind: "merge-confirmation" }
  | { kind: "review-adjudication" };

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
}

export type { DriverRun, DriverRunStatus };

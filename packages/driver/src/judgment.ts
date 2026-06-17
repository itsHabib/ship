/**
 * Judgment hooks, decide/markMerged/cancel, and §7.3 recovery (spec §4.1, §7).
 */

import type { Store } from "@ship/store";
import type { DriverBatch, DriverRun, DriverStream, StreamAttempt } from "@ship/store";
import type { FailureCategory, WorkflowRun } from "@ship/workflow";

import { LOCAL_RUN_CONTENTION_HINT } from "@ship/store";
import { failureCategorySchema } from "@ship/workflow";

import type { DriverShipPort } from "./ship-port.js";
import type {
  Decision,
  DriverStreamView,
  DriverTickResult,
  JudgmentRequest,
  MergeFacts,
} from "./types.js";

import { CancelError, DecideError } from "./errors.js";
import { parseManifest } from "./manifest.js";

const LIST_RUNS_LIMIT = 200;

export interface DispatchAmbiguity {
  streamId: string;
  candidates: { workflowRunId: string; createdAt: string; status: string }[];
}

/** Flatten all streams across batches in manifest order. */
export function allStreams(run: DriverRun): DriverStream[] {
  const out: DriverStream[] = [];
  for (const batch of run.batches) {
    for (const stream of batch.streams) {
      out.push(stream);
    }
  }
  return out;
}

/** Compact per-stream view for tick results. */
export function toStreamView(stream: DriverStream, batchIndex: number): DriverStreamView {
  const view: DriverStreamView = {
    batchIndex,
    runtime: stream.runtime,
    specPath: stream.specPath,
    status: stream.status,
    streamId: stream.id,
  };
  if (stream.taskSlug !== undefined) view.taskSlug = stream.taskSlug;
  if (stream.branch !== undefined) view.branch = stream.branch;
  if (stream.workflowRunId !== undefined) view.workflowRunId = stream.workflowRunId;
  if (stream.prUrl !== undefined) view.prUrl = stream.prUrl;
  return view;
}

export function buildStreamViews(run: DriverRun): DriverStreamView[] {
  return run.batches.flatMap((batch) =>
    batch.streams.map((stream) => toStreamView(stream, batch.batchIndex)),
  );
}

export function buildProgress(run: DriverRun): DriverTickResult["progress"] {
  const streams = allStreams(run);
  const activeBatch = run.batches.find((batch) =>
    batch.streams.some((s) => !isStreamDoneOrSkipped(s)),
  );
  const batchIndex = activeBatch?.batchIndex ?? run.batches.at(-1)?.batchIndex ?? 0;
  return {
    batchIndex,
    dispatched: streams.filter((s) => s.status === "dispatched" || s.status === "dispatching")
      .length,
    failed: streams.filter((s) => s.status === "failed").length,
    landed: streams.filter((s) => s.status === "landed" || s.status === "done").length,
    remaining: streams.filter((s) => s.status === "pending").length,
  };
}

function isStreamDoneOrSkipped(stream: DriverStream): boolean {
  return stream.status === "done" || stream.status === "skipped";
}

/** Mark each batch `done` once all its streams are terminal (done|skipped). */
export function rollBatchStatus(store: Store, run: DriverRun, completedAt?: string): void {
  const stampedAt = completedAt ?? new Date().toISOString();
  for (const batch of run.batches) {
    if (batch.status === "done") continue;
    if (!batch.streams.every(isStreamDoneOrSkipped)) continue;
    store.updateDriverBatch(batch.id, { completedAt: stampedAt, status: "done" });
  }
}

function hasUndecidedFailedStreams(run: DriverRun): boolean {
  return allStreams(run).some((s) => s.status === "failed");
}

function resumeAfterDecision(store: Store, driverRunId: string): DriverRun {
  const refreshed = store.getDriverRun(driverRunId);
  if (refreshed === null) {
    throw new DecideError(`driver run not found: ${driverRunId}`);
  }
  if (hasUndecidedFailedStreams(refreshed)) {
    return refreshed;
  }
  return store.updateDriverRunStatus(driverRunId, "running");
}

/** §7.3 recovery for streams stuck in `dispatching`. */
export async function recoverDispatchingStreams(
  store: Store,
  ship: DriverShipPort,
  run: DriverRun,
  ambiguities: DispatchAmbiguity[],
): Promise<DriverRun> {
  let current = run;
  for (const stream of allStreams(current)) {
    if (stream.status !== "dispatching") continue;
    current = await recoverOneStream(store, ship, current, stream, ambiguities);
  }
  return store.getDriverRun(current.id) ?? current;
}

async function recoverOneStream(
  store: Store,
  ship: DriverShipPort,
  run: DriverRun,
  stream: DriverStream,
  ambiguities: DispatchAmbiguity[],
): Promise<DriverRun> {
  const attempt = latestAttempt(stream);
  if (attempt?.docPath === undefined) {
    store.updateDriverStream(stream.id, { status: "pending" });
    return store.getDriverRun(run.id) ?? run;
  }

  const listed = await ship.listRuns({ limit: LIST_RUNS_LIMIT, repo: run.repo });
  if (listed.length >= LIST_RUNS_LIMIT) {
    pushAmbiguity(ambiguities, stream.id, listed);
    return run;
  }

  const candidates = filterRecoveryCandidates(listed, stream, attempt);
  if (candidates.length === 0) {
    store.updateDriverStream(stream.id, { status: "pending" });
    return store.getDriverRun(run.id) ?? run;
  }
  if (candidates.length === 1) {
    const match = candidates[0];
    if (match === undefined) return run;
    store.updateDriverStream(stream.id, {
      attempts: markAttemptWorkflowRunId(stream.attempts, match.id),
      status: "dispatched",
      workflowRunId: match.id,
    });
    return store.getDriverRun(run.id) ?? run;
  }

  pushAmbiguity(ambiguities, stream.id, candidates);
  return run;
}

function pushAmbiguity(
  ambiguities: DispatchAmbiguity[],
  streamId: string,
  runs: WorkflowRun[],
): void {
  ambiguities.push({
    candidates: runs.map((c) => ({
      createdAt: c.createdAt,
      status: c.status,
      workflowRunId: c.id,
    })),
    streamId,
  });
}

function filterRecoveryCandidates(
  runs: WorkflowRun[],
  stream: DriverStream,
  attempt: StreamAttempt,
): WorkflowRun[] {
  const dispatchMs = Date.parse(attempt.dispatchedAt);
  const docPath = attempt.docPath;
  return runs.filter((run) => {
    if (Date.parse(run.createdAt) < dispatchMs) return false;
    if (run.docPath !== docPath) return false;
    if ((stream.runtime === "local" || stream.runtime === "rooms") && stream.branch !== undefined) {
      return run.worktree.branch === stream.branch;
    }
    return true;
  });
}

function latestAttempt(stream: DriverStream): StreamAttempt | undefined {
  return stream.attempts.at(-1);
}

function markAttemptWorkflowRunId(
  attempts: StreamAttempt[],
  workflowRunId: string,
): StreamAttempt[] {
  if (attempts.length === 0) return attempts;
  const copy = [...attempts];
  const last = copy.at(-1);
  if (last === undefined) return copy;
  copy[copy.length - 1] = { ...last, workflowRunId };
  return copy;
}

export function buildFailureTriageRequests(run: DriverRun): JudgmentRequest[] {
  const requests: JudgmentRequest[] = [];
  for (const batch of run.batches) {
    for (const stream of batch.streams) {
      const req = buildFailureTriageRequest(run.id, stream);
      if (req !== undefined) requests.push(req);
    }
  }
  return requests;
}

function buildFailureTriageRequest(
  driverRunId: string,
  stream: DriverStream,
): JudgmentRequest | undefined {
  if (stream.status !== "failed") return undefined;

  const req: JudgmentRequest = {
    attempts: stream.attempts.length,
    driverRunId,
    failureCategory: toCanonicalCategory(latestAttempt(stream)?.failureCategory),
    kind: "failure-triage",
    streamId: stream.id,
  };
  // Only the LATEST attempt's workflow id belongs in triage — the stream-level
  // id can be a stale pointer to a previous attempt after a retry. Dispatch-time
  // failures have none; the request still surfaces (§7.2).
  const wfId = latestAttempt(stream)?.workflowRunId;
  if (wfId !== undefined) req.workflowRunId = wfId;
  if (stream.errorMessage !== undefined) req.errorMessage = stream.errorMessage;
  if (stream.errorMessage?.includes("local run contention")) {
    req.hint = LOCAL_RUN_CONTENTION_HINT;
  }
  return req;
}

function toCanonicalCategory(value: string | undefined): FailureCategory {
  const parsed = failureCategorySchema.safeParse(value);
  if (!parsed.success) return "unknown";
  return parsed.data;
}

export function buildDispatchAmbiguityRequests(
  run: DriverRun,
  ambiguities: DispatchAmbiguity[],
): JudgmentRequest[] {
  return ambiguities.map((a) => ({
    candidates: a.candidates,
    driverRunId: run.id,
    kind: "dispatch-ambiguity" as const,
    streamId: a.streamId,
  }));
}

export function buildUnmergedViews(run: DriverRun): DriverStreamView[] {
  const views: DriverStreamView[] = [];
  for (const batch of run.batches) {
    for (const stream of batch.streams) {
      if (stream.status !== "landed") continue;
      views.push(toStreamView(stream, batch.batchIndex));
    }
  }
  return views;
}

export function hasInFlightStreams(run: DriverRun): boolean {
  return allStreams(run).some((s) => s.status === "dispatching" || s.status === "dispatched");
}

export function decide(
  store: Store,
  driverRunId: string,
  streamId: string,
  decision: Decision,
): DriverRun {
  const run = loadRunForDecision(store, driverRunId);
  const stream = findStream(run, streamId);
  if (stream === undefined) {
    throw new DecideError(`stream not found: ${streamId}`);
  }

  switch (decision.kind) {
    case "retry":
      return applyRetryDecision(store, driverRunId, streamId, stream);
    case "skip":
      return applySkipDecision(store, driverRunId, streamId, stream, decision.reason);
    case "abort":
      return store.updateDriverRunStatus(driverRunId, "failed");
    case "adopt":
      return applyAdoptDecision(store, driverRunId, streamId, stream, decision.workflowRunId);
  }
}

function loadRunForDecision(store: Store, driverRunId: string): DriverRun {
  const run = store.getDriverRun(driverRunId);
  if (run === null) {
    throw new DecideError(`driver run not found: ${driverRunId}`);
  }
  if (run.status !== "awaiting_judgment") {
    throw new DecideError(`run ${driverRunId} is not awaiting judgment (status=${run.status})`);
  }
  return run;
}

function applyRetryDecision(
  store: Store,
  driverRunId: string,
  streamId: string,
  stream: DriverStream,
): DriverRun {
  // `dispatching` is the ambiguity resting state (§7.3) — retry abandons the
  // candidates and re-dispatches fresh, the documented alternative to adopt.
  if (stream.status !== "failed" && stream.status !== "dispatching") {
    throw new DecideError(
      `stream ${streamId} is not failed or dispatching (status=${stream.status})`,
    );
  }
  store.updateDriverStream(streamId, { status: "pending" });
  return resumeAfterDecision(store, driverRunId);
}

function applySkipDecision(
  store: Store,
  driverRunId: string,
  streamId: string,
  stream: DriverStream,
  reason: string,
): DriverRun {
  if (stream.status !== "failed") {
    throw new DecideError(`stream ${streamId} is not failed (status=${stream.status})`);
  }
  store.updateDriverStream(streamId, { errorMessage: reason, status: "skipped" });
  return resumeAfterDecision(store, driverRunId);
}

function applyAdoptDecision(
  store: Store,
  driverRunId: string,
  streamId: string,
  stream: DriverStream,
  workflowRunId: string,
): DriverRun {
  if (stream.status !== "dispatching") {
    throw new DecideError(
      `stream ${streamId} is not dispatching for adopt (status=${stream.status})`,
    );
  }
  store.updateDriverStream(streamId, {
    attempts: markAttemptWorkflowRunId(stream.attempts, workflowRunId),
    status: "dispatched",
    workflowRunId,
  });
  return resumeAfterDecision(store, driverRunId);
}

export function markMerged(
  store: Store,
  driverRunId: string,
  streamId: string,
  facts: MergeFacts,
): DriverRun {
  const run = store.getDriverRun(driverRunId);
  if (run === null) {
    throw new DecideError(`driver run not found: ${driverRunId}`);
  }
  const stream = findStream(run, streamId);
  if (stream === undefined) {
    throw new DecideError(`stream not found: ${streamId}`);
  }
  if (stream.status !== "landed" && stream.status !== "done") {
    throw new DecideError(`stream ${streamId} is not landed (status=${stream.status})`);
  }

  const patch: Parameters<Store["updateDriverStream"]>[1] = {
    mergeCommit: facts.mergeCommit,
    prNumber: facts.prNumber,
    status: "done",
  };
  if (facts.mergedAt !== undefined) patch.mergedAt = facts.mergedAt;
  if (facts.cycles !== undefined) patch.cycles = facts.cycles;
  store.updateDriverStream(streamId, patch);

  let refreshed = store.getDriverRun(driverRunId) ?? run;
  rollBatchStatus(store, refreshed, facts.mergedAt);
  refreshed = store.getDriverRun(driverRunId) ?? refreshed;
  if (everyStreamTerminalDoneOrSkipped(refreshed)) {
    return store.updateDriverRunStatus(driverRunId, "done");
  }
  return refreshed;
}

export async function cancelRun(
  store: Store,
  ship: DriverShipPort,
  driverRunId: string,
  now: string,
): Promise<DriverRun> {
  const run = store.getDriverRun(driverRunId);
  if (run === null) {
    throw new CancelError(`driver run not found: ${driverRunId}`);
  }
  if (run.status === "cancelled") {
    return run;
  }

  for (const stream of allStreams(run)) {
    if (stream.status !== "dispatching" && stream.status !== "dispatched") continue;
    const wfId = stream.workflowRunId;
    if (wfId !== undefined) {
      try {
        await ship.cancelRun(wfId);
      } catch {
        // Idempotent sweep — record and continue (§8 v2).
      }
    }
    // Cancellation is not a failure category (`cancelled` is excluded from the
    // canonical enum); the attempt records only the terminal fact.
    const attempt: StreamAttempt = { dispatchedAt: now, terminal: true };
    if (wfId !== undefined) attempt.workflowRunId = wfId;
    store.updateDriverStream(stream.id, {
      attempts: [...stream.attempts, attempt],
      errorMessage: "cancelled by driver",
      status: "failed",
    });
  }

  return store.updateDriverRunStatus(driverRunId, "cancelled");
}

function findStream(run: DriverRun, streamId: string): DriverStream | undefined {
  for (const batch of run.batches) {
    const found = batch.streams.find((s) => s.id === streamId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Batch is dispatch-eligible when all deps have every stream done|skipped (§7.6). */
export function isBatchEligible(
  batch: DriverBatch,
  batches: DriverBatch[],
  targetBatch?: number,
): boolean {
  if (targetBatch !== undefined && batch.batchIndex !== targetBatch) {
    return false;
  }
  for (const depIndex of batch.dependsOn) {
    const dep = batches.find((b) => b.batchIndex === depIndex);
    if (dep === undefined) continue;
    if (!dep.streams.every((s) => s.status === "done" || s.status === "skipped")) {
      return false;
    }
  }
  return true;
}

/**
 * True when the only remaining work is policy-side merging: nothing in
 * flight, nothing dispatch-eligible, and landed streams await mark-merged.
 * Covers both dep-gated batches and a final batch that is fully landed.
 */
export function isBlockedOnMerges(run: DriverRun): boolean {
  if (hasInFlightStreams(run)) return false;
  if (run.batches.some((b) => batchHasPendingDispatchable(b, run.batches))) return false;
  return allStreams(run).some((s) => s.status === "landed");
}

export function extractRepoUrl(run: DriverRun): string | undefined {
  const parsed = parseManifest(run.sourceJson);
  if (!parsed.ok) return undefined;
  return parsed.manifest.repo_url;
}

export function batchHasPendingDispatchable(batch: DriverBatch, batches: DriverBatch[]): boolean {
  if (!isBatchEligible(batch, batches)) return false;
  return batch.streams.some((s) => s.status === "pending");
}

export function everyStreamTerminalDoneOrSkipped(run: DriverRun): boolean {
  return allStreams(run).every((s) => s.status === "done" || s.status === "skipped");
}

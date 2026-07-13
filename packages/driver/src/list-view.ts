/**
 * Public list projection for Portfolio Control Room (`ship driver list --json`).
 * Maps store `DriverRun` rows to a versioned envelope without leaking
 * `sourceJson`, absolute `manifestPath`, or other internal-only fields.
 */

import type {
  DriverBatch,
  DriverRun,
  DriverRunStatus,
  DriverStream,
  StreamAttempt,
} from "@ship/store";

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { resolveRepoRoot } from "./engine.js";

export const DRIVER_LIST_ENVELOPE_VERSION = 1 as const;

export interface DriverListEnvelope {
  v: typeof DRIVER_LIST_ENVELOPE_VERSION;
  runs: DriverListRunView[];
}

export interface DriverListRunView {
  driverRunId: string;
  status: DriverRunStatus;
  repo: string;
  project?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string;
  sourceHash: string;
  manifestRef?: string;
  batches: DriverListBatchView[];
}

export interface DriverListBatchView {
  batchId: string;
  batchIndex: number;
  label?: string;
  status: DriverBatch["status"];
  completedAt?: string;
  dependsOn: number[];
  streams: DriverListStreamView[];
}

export interface DriverListStreamView {
  streamId: string;
  streamIndex: number;
  taskId?: string;
  taskSlug?: string;
  specPath: string;
  branch?: string;
  runtime: DriverStream["runtime"];
  status: DriverStream["status"];
  touches: string[];
  createdAt: string;
  updatedAt: string;
  provider?: DriverStream["provider"];
  modelTier?: DriverStream["modelTier"];
  effortTier?: DriverStream["effortTier"];
  dispatchProvider?: DriverStream["dispatchProvider"];
  dispatchModel?: string;
  dispatchModelParams?: DriverStream["dispatchModelParams"];
  effortDegraded?: boolean;
  tierDegradeReason?: string;
  workflowRunId?: string;
  prUrl?: string;
  prNumber?: number;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
  reviewCycles?: number;
  errorMessage?: string;
  attempts: DriverListAttemptView[];
}

export interface DriverListAttemptView {
  dispatchedAt: string;
  terminal: boolean;
  workflowRunId?: string;
  failureCategory?: string;
}

/** Build the versioned list envelope from hydrated store rows. */
export function buildDriverListEnvelope(runs: readonly DriverRun[]): DriverListEnvelope {
  return {
    v: DRIVER_LIST_ENVELOPE_VERSION,
    runs: runs.map(buildDriverListRunView),
  };
}

function buildDriverListRunView(run: DriverRun): DriverListRunView {
  const view: DriverListRunView = {
    batches: run.batches.map(buildDriverListBatchView),
    createdAt: run.createdAt,
    driverRunId: run.id,
    repo: run.repo,
    sourceHash: hashSourceJson(run.sourceJson),
    status: run.status,
    updatedAt: run.updatedAt,
  };
  if (run.project !== undefined) view.project = run.project;
  if (run.phase !== undefined) view.phase = run.phase;
  const manifestRef = resolveSafeManifestRef(run.manifestPath);
  if (manifestRef !== undefined) view.manifestRef = manifestRef;
  return view;
}

function buildDriverListBatchView(batch: DriverBatch): DriverListBatchView {
  const view: DriverListBatchView = {
    batchId: batch.id,
    batchIndex: batch.batchIndex,
    dependsOn: [...batch.dependsOn],
    status: batch.status,
    streams: batch.streams.map(buildDriverListStreamView),
  };
  if (batch.label !== undefined) view.label = batch.label;
  if (batch.completedAt !== undefined) view.completedAt = batch.completedAt;
  return view;
}

function buildDriverListStreamView(stream: DriverStream): DriverListStreamView {
  return {
    attempts: stream.attempts.map(buildDriverListAttemptView),
    createdAt: stream.createdAt,
    runtime: stream.runtime,
    specPath: stream.specPath,
    status: stream.status,
    streamId: stream.id,
    streamIndex: stream.streamIndex,
    touches: [...stream.touches],
    updatedAt: stream.updatedAt,
    ...optionalStreamIdentityFields(stream),
    ...optionalStreamRequestedFields(stream),
    ...optionalStreamProgressFields(stream),
    ...liveDispatchFields(stream),
  };
}

function optionalStreamIdentityFields(
  stream: DriverStream,
): Pick<DriverListStreamView, "taskId" | "taskSlug" | "branch"> {
  const fields: Pick<DriverListStreamView, "taskId" | "taskSlug" | "branch"> = {};
  if (stream.taskId !== undefined) fields.taskId = stream.taskId;
  if (stream.taskSlug !== undefined) fields.taskSlug = stream.taskSlug;
  if (stream.branch !== undefined) fields.branch = stream.branch;
  return fields;
}

function optionalStreamRequestedFields(
  stream: DriverStream,
): Pick<DriverListStreamView, "provider" | "modelTier" | "effortTier"> {
  const fields: Pick<DriverListStreamView, "provider" | "modelTier" | "effortTier"> = {};
  if (stream.provider !== undefined) fields.provider = stream.provider;
  if (stream.modelTier !== undefined) fields.modelTier = stream.modelTier;
  if (stream.effortTier !== undefined) fields.effortTier = stream.effortTier;
  return fields;
}

function optionalStreamProgressFields(
  stream: DriverStream,
): Pick<
  DriverListStreamView,
  | "workflowRunId"
  | "prUrl"
  | "prNumber"
  | "mergeCommit"
  | "mergedAt"
  | "cycles"
  | "reviewCycles"
  | "errorMessage"
> {
  const fields: Pick<
    DriverListStreamView,
    | "workflowRunId"
    | "prUrl"
    | "prNumber"
    | "mergeCommit"
    | "mergedAt"
    | "cycles"
    | "reviewCycles"
    | "errorMessage"
  > = {};
  if (stream.workflowRunId !== undefined) fields.workflowRunId = stream.workflowRunId;
  if (stream.prUrl !== undefined) fields.prUrl = stream.prUrl;
  if (stream.prNumber !== undefined) fields.prNumber = stream.prNumber;
  if (stream.mergeCommit !== undefined) fields.mergeCommit = stream.mergeCommit;
  if (stream.mergedAt !== undefined) fields.mergedAt = stream.mergedAt;
  if (stream.cycles !== undefined) fields.cycles = stream.cycles;
  if (stream.reviewCycles !== undefined) fields.reviewCycles = stream.reviewCycles;
  const errorMessage = sanitizeErrorMessage(stream.errorMessage);
  if (errorMessage !== undefined) fields.errorMessage = errorMessage;
  return fields;
}

function liveDispatchFields(
  stream: DriverStream,
): Pick<
  DriverListStreamView,
  | "dispatchProvider"
  | "dispatchModel"
  | "dispatchModelParams"
  | "effortDegraded"
  | "tierDegradeReason"
> {
  if (stream.status === "pending") return {};
  const fields: Pick<
    DriverListStreamView,
    | "dispatchProvider"
    | "dispatchModel"
    | "dispatchModelParams"
    | "effortDegraded"
    | "tierDegradeReason"
  > = {};
  if (stream.dispatchProvider !== undefined) fields.dispatchProvider = stream.dispatchProvider;
  if (stream.dispatchModel !== undefined) fields.dispatchModel = stream.dispatchModel;
  if (stream.dispatchModelParams !== undefined) {
    fields.dispatchModelParams = stream.dispatchModelParams.map((param) => ({ ...param }));
  }
  if (stream.effortDegraded === true) fields.effortDegraded = true;
  if (stream.tierDegradeReason !== undefined) fields.tierDegradeReason = stream.tierDegradeReason;
  return fields;
}

function buildDriverListAttemptView(attempt: StreamAttempt): DriverListAttemptView {
  const view: DriverListAttemptView = {
    dispatchedAt: attempt.dispatchedAt,
    terminal: attempt.terminal,
  };
  if (attempt.workflowRunId !== undefined) view.workflowRunId = attempt.workflowRunId;
  if (attempt.failureCategory !== undefined) view.failureCategory = attempt.failureCategory;
  return view;
}

function hashSourceJson(sourceJson: string): string {
  return createHash("sha256").update(sourceJson, "utf8").digest("hex");
}

function sanitizeErrorMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const quoted = message.replace(/(["'])(?:[A-Za-z]:\\|\/)[^"'\r\n]*\1/g, "[path]");
  // An unquoted path has no reliable terminator because spaces are legal in
  // both POSIX and Windows paths. Fail closed: retain the safe prefix and
  // redact the rest of the one-line diagnostic once an absolute marker starts.
  return quoted.replace(
    /(^|[\s(,;=])(?:[A-Za-z]:\\|\/).*$/g,
    (_match, prefix: string) => `${prefix}[path]`,
  );
}

function resolveSafeManifestRef(manifestPath: string): string | undefined {
  try {
    const repoRoot = resolve(resolveRepoRoot(manifestPath));
    const resolvedManifest = resolve(manifestPath);
    const rel = relative(repoRoot, resolvedManifest);
    // On Windows, path.relative returns the absolute target when the paths
    // are on different drive letters. Never publish that as a manifest ref.
    if (isAbsolute(rel) || rel.startsWith("..")) return undefined;
    return rel.split("\\").join("/");
  } catch {
    return undefined;
  }
}

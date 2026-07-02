/**
 * Import a `driver.md` manifest into the store as a `driver_run` aggregate.
 */

import type { Store } from "@ship/store";
import type { DriverRun } from "@ship/store";
import type { DriverBatchStatus } from "@ship/store";

import { newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { readFileSync } from "node:fs";

import type { ManifestBatch, ManifestParseError, ManifestStream } from "./manifest.js";

import { parseManifest } from "./manifest.js";
import {
  manifestBatchStatusToStore,
  manifestStatusToStore,
  resolveStreamTier,
} from "./status-mapping.js";

export class ImportManifestError extends Error {
  override readonly name = "ImportManifestError";
  readonly errors: ManifestParseError[];

  constructor(errors: ManifestParseError[]) {
    super(`failed to parse driver manifest: ${errors.map((e) => e.message).join("; ")}`);
    this.errors = errors;
  }
}

export interface ImportManifestResult {
  run: DriverRun;
  alreadyImported?: boolean;
  warnings?: string[];
}

// A missing or unreadable manifest is caller error, same as an unparseable
// one — both CLI and MCP error mappers already classify ImportManifestError.
function readManifestFile(manifestPath: string): string {
  try {
    return readFileSync(manifestPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ImportManifestError([{ message: `cannot read manifest: ${detail}` }]);
  }
}

/** Read, parse, and insert a manifest; idempotent by (repo, project, phase, generated_at). */
export function importManifest(store: Store, manifestPath: string): ImportManifestResult {
  const sourceJson = readManifestFile(manifestPath);
  const parsed = parseManifest(sourceJson);
  if (!parsed.ok) {
    throw new ImportManifestError(parsed.errors);
  }

  const { manifest, warnings } = parsed;
  const project = manifest.source.project;
  const phase = manifest.source.phase;
  const warningExtras = warnings.length > 0 ? { warnings } : {};
  const existing = findExistingRun(store, manifest.repo, project, phase, manifest.generated_at);
  if (existing !== undefined) {
    return { alreadyImported: true, run: existing, ...warningExtras };
  }

  const batches = manifest.batches.map((batch) =>
    buildBatchInput(
      batch,
      manifest.default_runtime,
      manifest.default_model,
      manifest.default_effort,
    ),
  );
  const runStatus = deriveRunStatus(batches.map((b) => b.status));

  const run = store.insertDriverRun({
    batches,
    id: newDriverRunId(),
    manifestPath,
    phase,
    project,
    repo: manifest.repo,
    sourceJson,
    status: runStatus,
  });

  return { run, ...warningExtras };
}

function findExistingRun(
  store: Store,
  repo: string,
  project: string,
  phase: string,
  generatedAt: string,
): DriverRun | undefined {
  // Filtering by the full identity tuple keeps the candidate set to re-runs
  // of this one phase, so the list cap can't hide an older run behind
  // unrelated newer ones.
  const candidates = store.listDriverRuns({ limit: 200, phase, project, repo });
  for (const run of candidates) {
    const storedGeneratedAt = extractGeneratedAt(run.sourceJson);
    if (storedGeneratedAt === generatedAt) {
      return run;
    }
  }
  return undefined;
}

function extractGeneratedAt(sourceJson: string): string | undefined {
  const parsed = parseManifest(sourceJson);
  if (!parsed.ok) {
    return undefined;
  }
  return parsed.manifest.generated_at;
}

function deriveRunStatus(batchStatuses: DriverBatchStatus[]): DriverRun["status"] {
  if (batchStatuses.length > 0 && batchStatuses.every((status) => status === "done")) {
    return "done";
  }
  return "pending";
}

function buildBatchInput(
  batch: ManifestBatch,
  defaultRuntime: ManifestStream["runtime"] | undefined,
  defaultModel: ManifestStream["model"] | undefined,
  defaultEffort: ManifestStream["effort"] | undefined,
): {
  id: string;
  batchIndex: number;
  label?: string;
  dependsOn: number[];
  status: "pending" | "running" | "done" | "failed";
  completedAt?: string;
  streams: {
    id: string;
    streamIndex: number;
    taskId?: string;
    taskSlug?: string;
    specPath: string;
    branch?: string;
    runtime: string;
    touches: string[];
    status: ReturnType<typeof manifestStatusToStore>;
    attempts: [];
    prNumber?: number;
    mergeCommit?: string;
    mergedAt?: string;
    cycles?: number;
  }[];
} {
  const batchStatus = manifestBatchStatusToStore(batch.status, batch.completed_at);
  const streams = batch.streams.map((stream, index) =>
    buildStreamInput(stream, index, defaultRuntime, defaultModel, defaultEffort),
  );

  const result: {
    id: string;
    batchIndex: number;
    label?: string;
    dependsOn: number[];
    status: "pending" | "running" | "done" | "failed";
    completedAt?: string;
    streams: ReturnType<typeof buildStreamInput>[];
  } = {
    batchIndex: batch.id,
    dependsOn: batch.depends_on,
    id: newDriverBatchId(),
    status: batchStatus.status,
    streams,
  };
  if (batchStatus.completedAt !== undefined) result.completedAt = batchStatus.completedAt;
  if (batch.label !== undefined) result.label = batch.label;
  return result;
}

function buildStreamInput(
  stream: ManifestStream,
  streamIndex: number,
  defaultRuntime: ManifestStream["runtime"] | undefined,
  defaultModel: ManifestStream["model"] | undefined,
  defaultEffort: ManifestStream["effort"] | undefined,
): {
  id: string;
  streamIndex: number;
  taskId?: string;
  taskSlug?: string;
  specPath: string;
  branch?: string;
  runtime: string;
  touches: string[];
  status: ReturnType<typeof manifestStatusToStore>;
  attempts: [];
  prNumber?: number;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
  modelTier?: ReturnType<typeof resolveStreamTier>["modelTier"];
  effortTier?: ReturnType<typeof resolveStreamTier>["effortTier"];
} {
  const candidate: {
    id: string;
    streamIndex: number;
    specPath: string;
    runtime: string;
    touches: string[];
    status: ReturnType<typeof manifestStatusToStore>;
    attempts: [];
    taskId?: string;
    taskSlug?: string;
    branch?: string;
    prNumber?: number;
    mergeCommit?: string;
    mergedAt?: string;
    cycles?: number;
    modelTier?: ReturnType<typeof resolveStreamTier>["modelTier"];
    effortTier?: ReturnType<typeof resolveStreamTier>["effortTier"];
  } = {
    attempts: [],
    id: newDriverStreamId(),
    runtime: stream.runtime ?? defaultRuntime ?? "local",
    specPath: stream.spec_path,
    status: manifestStatusToStore(stream.status),
    streamIndex,
    touches: stream.touches,
    ...resolveStreamTier(stream, defaultModel, defaultEffort),
  };
  if (stream.task_id !== undefined) candidate.taskId = stream.task_id;
  if (stream.task_slug !== undefined) candidate.taskSlug = stream.task_slug;
  if (stream.branch_name !== undefined) candidate.branch = stream.branch_name;
  if (stream.pr_number !== undefined) candidate.prNumber = stream.pr_number;
  if (stream.merge_commit !== undefined) candidate.mergeCommit = stream.merge_commit;
  if (stream.merged_at !== undefined) candidate.mergedAt = stream.merged_at;
  if (stream.cycles !== undefined) candidate.cycles = stream.cycles;
  return candidate;
}

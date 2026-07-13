/**
 * Import a `driver.md` manifest into the store as a `driver_run` aggregate.
 */

import type { Store } from "@ship/store";
import type { DriverRun } from "@ship/store";
import type { DriverBatchStatus } from "@ship/store";
import type { AgentProvider } from "@ship/workflow";

import { newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { readFileSync } from "node:fs";

import type { ManifestBatch, ManifestParseError, ManifestStream } from "./manifest.js";

import { parseManifest } from "./manifest.js";
import {
  manifestBatchStatusToStore,
  manifestStatusToStore,
  resolveStreamProvider,
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

  const providerErrors = collectProviderValidationErrors(
    manifest.batches,
    manifest.default_runtime,
    manifest.default_provider,
  );
  if (providerErrors.length > 0) {
    throw new ImportManifestError(providerErrors);
  }

  const batches = manifest.batches.map((batch) =>
    buildBatchInput(batch, {
      defaultEffort: manifest.default_effort,
      defaultModel: manifest.default_model,
      defaultProvider: manifest.default_provider,
      defaultRuntime: manifest.default_runtime,
    }),
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

function collectProviderValidationErrors(
  batches: ManifestBatch[],
  defaultRuntime: ManifestStream["runtime"] | undefined,
  defaultProvider: AgentProvider | undefined,
): ManifestParseError[] {
  const errors: ManifestParseError[] = [];
  for (const batch of batches) {
    for (const stream of batch.streams) {
      const runtime = stream.runtime ?? defaultRuntime ?? "local";
      const provider = resolveStreamProvider(stream, defaultProvider).provider;
      const streamError = validateStreamProviderRules(stream, runtime, provider);
      if (streamError !== undefined) errors.push(streamError);
    }
  }
  return errors;
}

function validateStreamProviderRules(
  stream: ManifestStream,
  runtime: NonNullable<ManifestStream["runtime"]> | "local",
  provider: AgentProvider | undefined,
): ManifestParseError | undefined {
  if (provider === undefined) return undefined;
  const label = streamLabel(stream);
  if (provider === "codex" && runtime !== "local") {
    return {
      message: `stream ${label}: codex provider supports only runtime 'local' (runtime is '${runtime}')`,
    };
  }
  if (provider === "claude" && runtime === "cloud" && !stream.branch_name) {
    return {
      message: `stream ${label}: claude provider with runtime 'cloud' requires branch_name`,
    };
  }
  return undefined;
}

function streamLabel(stream: ManifestStream): string {
  if (stream.task_slug !== undefined) return stream.task_slug;
  return stream.spec_path;
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

interface ManifestStreamDefaults {
  defaultRuntime: ManifestStream["runtime"] | undefined;
  defaultModel: ManifestStream["model"] | undefined;
  defaultEffort: ManifestStream["effort"] | undefined;
  defaultProvider: AgentProvider | undefined;
}

function buildBatchInput(
  batch: ManifestBatch,
  defaults: ManifestStreamDefaults,
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
    rollsUp?: string[];
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
  const streams = batch.streams.map((stream, index) => buildStreamInput(stream, index, defaults));

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
  defaults: ManifestStreamDefaults,
): {
  id: string;
  streamIndex: number;
  taskId?: string;
  taskSlug?: string;
  specPath: string;
  branch?: string;
  runtime: string;
  rollsUp?: string[];
  touches: string[];
  status: ReturnType<typeof manifestStatusToStore>;
  attempts: [];
  prNumber?: number;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
  modelTier?: ReturnType<typeof resolveStreamTier>["modelTier"];
  effortTier?: ReturnType<typeof resolveStreamTier>["effortTier"];
  provider?: ReturnType<typeof resolveStreamProvider>["provider"];
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
    rollsUp?: string[];
    prNumber?: number;
    mergeCommit?: string;
    mergedAt?: string;
    cycles?: number;
    modelTier?: ReturnType<typeof resolveStreamTier>["modelTier"];
    effortTier?: ReturnType<typeof resolveStreamTier>["effortTier"];
    provider?: ReturnType<typeof resolveStreamProvider>["provider"];
  } = {
    attempts: [],
    id: newDriverStreamId(),
    runtime: stream.runtime ?? defaults.defaultRuntime ?? "local",
    specPath: stream.spec_path,
    status: manifestStatusToStore(stream.status),
    streamIndex,
    touches: stream.touches,
    ...resolveStreamTier(stream, defaults.defaultModel, defaults.defaultEffort),
    ...resolveStreamProvider(stream, defaults.defaultProvider),
    ...optionalStreamInputFields(stream),
  };
  return candidate;
}

/** The optional stream fields carried verbatim from manifest to store input. */
function optionalStreamInputFields(stream: ManifestStream): {
  taskId?: string;
  taskSlug?: string;
  branch?: string;
  rollsUp?: string[];
  prNumber?: number;
  mergeCommit?: string;
  mergedAt?: string;
  cycles?: number;
} {
  return {
    ...(stream.task_id !== undefined ? { taskId: stream.task_id } : {}),
    ...(stream.task_slug !== undefined ? { taskSlug: stream.task_slug } : {}),
    ...(stream.branch_name !== undefined ? { branch: stream.branch_name } : {}),
    ...(stream.rolls_up !== undefined ? { rollsUp: stream.rolls_up } : {}),
    ...(stream.pr_number !== undefined ? { prNumber: stream.pr_number } : {}),
    ...(stream.merge_commit !== undefined ? { mergeCommit: stream.merge_commit } : {}),
    ...(stream.merged_at !== undefined ? { mergedAt: stream.merged_at } : {}),
    ...(stream.cycles !== undefined ? { cycles: stream.cycles } : {}),
  };
}

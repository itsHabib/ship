/**
 * Import a `driver.md` manifest into the store as a `driver_run` aggregate.
 */

import type {
  DriverBatchStatus,
  DriverRun,
  FallbackChainTarget,
  FallbackLogRecord,
  Store,
} from "@ship/store";
import type { AgentProvider } from "@ship/workflow";

import { newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CellStructuralIssue } from "./dispatch-cell.js";
import type {
  DriverManifest,
  ManifestBatch,
  ManifestFallbackTarget,
  ManifestParseError,
  ManifestStream,
} from "./manifest.js";
import type { LoadedDispatchPolicy, PolicyRuntime } from "./policy.js";

import { cellStructuralIssue, missingCredentialEnv } from "./dispatch-cell.js";
import { DEFAULT_DISPATCH_PROVIDER } from "./engine.js";
import { parseManifest } from "./manifest.js";
import {
  loadDispatchPolicy,
  providerCeilingViolation,
  resolveDispatchProvider,
  resolveDispatchRuntime,
  runtimeCeilingViolation,
} from "./policy.js";
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

/** Options for `importManifest`. `env` is injectable for the fallback env-warning check. */
export interface ImportManifestOptions {
  env?: Record<string, string | undefined>;
}

/** Read, parse, and insert a manifest; idempotent by (repo, project, phase, generated_at). */
export function importManifest(
  store: Store,
  manifestPath: string,
  opts: ImportManifestOptions = {},
): ImportManifestResult {
  const sourceJson = readManifestFile(manifestPath);
  const parsed = parseManifest(sourceJson);
  if (!parsed.ok) {
    throw new ImportManifestError(parsed.errors);
  }

  const { manifest, warnings } = parsed;
  const project = manifest.source.project;
  const phase = manifest.source.phase;
  // Load the repo policy fail-closed before any early return: a broken
  // `.ship.json` must error even on a re-import, never silently pass through.
  const policy = loadDispatchPolicy(dirname(manifestPath));
  // Env warnings are re-derived on every import, re-imports included — the
  // credential landscape at THIS import is what the caller can act on.
  const allWarnings = [
    ...warnings,
    ...policy.warnings,
    ...collectFallbackEnvWarnings(manifest, opts.env ?? process.env),
  ];
  const warningExtras = allWarnings.length > 0 ? { warnings: allWarnings } : {};
  const existing = findExistingRun(store, manifest.repo, project, phase, manifest.generated_at);
  if (existing !== undefined) {
    return { alreadyImported: true, run: existing, ...warningExtras };
  }

  const providerErrors = collectProviderValidationErrors(
    manifest.batches,
    manifest.default_runtime,
    manifest.default_provider,
    policy,
  );
  if (providerErrors.length > 0) {
    throw new ImportManifestError(providerErrors);
  }

  const fallbackErrors = collectFallbackValidationErrors(manifest, policy);
  if (fallbackErrors.length > 0) {
    throw new ImportManifestError(fallbackErrors);
  }

  const batches = manifest.batches.map((batch) =>
    buildBatchInput(batch, {
      defaultEffort: manifest.default_effort,
      defaultFallback: manifest.default_fallback,
      defaultModel: manifest.default_model,
      defaultModelId: manifest.default_model_id,
      defaultProvider: manifest.default_provider,
      defaultRuntime: manifest.default_runtime,
      policy,
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
  policy: LoadedDispatchPolicy,
): ManifestParseError[] {
  const errors: ManifestParseError[] = [];
  for (const batch of batches) {
    for (const stream of batch.streams) {
      const runtime = resolveDispatchRuntime(policy, stream.runtime, defaultRuntime);
      const provider = resolveDispatchProvider(policy, stream.provider, defaultProvider);
      const streamError = validateStreamProviderRules(stream, runtime, provider);
      if (streamError !== undefined) errors.push(streamError);
      errors.push(...collectStreamCeilingErrors(policy, stream, runtime, provider));
    }
  }
  return errors;
}

function collectStreamCeilingErrors(
  policy: LoadedDispatchPolicy,
  stream: ManifestStream,
  runtime: PolicyRuntime,
  provider: AgentProvider | undefined,
): ManifestParseError[] {
  const errors: ManifestParseError[] = [];
  const label = streamLabel(stream);
  const runtimeViolation = runtimeCeilingViolation(policy, runtime);
  if (runtimeViolation !== undefined) {
    errors.push({ message: `stream ${label}: ${runtimeViolation}` });
  }
  const providerViolation = providerCeilingViolation(policy, provider);
  if (providerViolation !== undefined) {
    errors.push({ message: `stream ${label}: ${providerViolation}` });
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
  defaultModelId: ManifestStream["model_id"] | undefined;
  defaultEffort: ManifestStream["effort"] | undefined;
  defaultProvider: AgentProvider | undefined;
  policy: LoadedDispatchPolicy;
  defaultFallback: ManifestFallbackTarget[] | undefined;
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
  modelId?: ReturnType<typeof resolveStreamTier>["modelId"];
  effortTier?: ReturnType<typeof resolveStreamTier>["effortTier"];
  provider?: AgentProvider;
  reviewCycles: number;
  fallbackChain?: FallbackChainTarget[];
  fallbackCursor?: number;
  fallbackLog?: FallbackLogRecord[];
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
    modelId?: ReturnType<typeof resolveStreamTier>["modelId"];
    effortTier?: ReturnType<typeof resolveStreamTier>["effortTier"];
    provider?: AgentProvider;
    reviewCycles: number;
    fallbackChain?: FallbackChainTarget[];
    fallbackCursor?: number;
    fallbackLog?: FallbackLogRecord[];
  } = {
    attempts: [],
    id: newDriverStreamId(),
    runtime: resolveDispatchRuntime(defaults.policy, stream.runtime, defaults.defaultRuntime),
    specPath: stream.spec_path,
    status: manifestStatusToStore(stream.status),
    streamIndex,
    touches: stream.touches,
    ...resolveStreamTier(
      stream,
      defaults.defaultModel,
      defaults.defaultEffort,
      defaults.defaultModelId,
    ),
    ...policyProviderField(defaults, stream),
    ...optionalStreamInputFields(stream),
    reviewCycles: 0,
    ...buildFallbackFields(stream, defaults.defaultFallback),
  };
  return candidate;
}

/** Resolved provider with the policy default folded in; omitted when unset. */
function policyProviderField(
  defaults: ManifestStreamDefaults,
  stream: ManifestStream,
): { provider?: AgentProvider } {
  const provider = resolveDispatchProvider(
    defaults.policy,
    stream.provider,
    defaults.defaultProvider,
  );
  return provider !== undefined ? { provider } : {};
}

// Freeze the stream's effective fallback chain onto its row (spec §7.1 step 4):
// cursor at 0, empty log. Streams with no chain leave all three columns absent —
// the feature is opt-in, so a chainless stream's row is byte-for-byte as today.
function buildFallbackFields(
  stream: ManifestStream,
  defaultFallback: ManifestFallbackTarget[] | undefined,
): {
  fallbackChain?: FallbackChainTarget[];
  fallbackCursor?: number;
  fallbackLog?: FallbackLogRecord[];
} {
  const chain = resolveEffectiveChain(stream, defaultFallback);
  if (chain.length === 0) return {};
  return { fallbackChain: chain.map(toStoreChainTarget), fallbackCursor: 0, fallbackLog: [] };
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

// A stream's effective chain: its own `fallback`, else the run `default_fallback`,
// else empty (spec §7.1 step 1). `??` — an explicit `[]` opts out of inheritance.
function resolveEffectiveChain(
  stream: ManifestStream,
  defaultFallback: ManifestFallbackTarget[] | undefined,
): ManifestFallbackTarget[] {
  return stream.fallback ?? defaultFallback ?? [];
}

// Manifest entry (snake_case model_id) → the persisted store target (modelId).
function toStoreChainTarget(entry: ManifestFallbackTarget): FallbackChainTarget {
  if (entry.model_id === undefined) {
    return { provider: entry.provider, runtime: entry.runtime };
  }
  return { modelId: entry.model_id, provider: entry.provider, runtime: entry.runtime };
}

// Identity of a dispatch target for dupe detection: the full (runtime, provider,
// model_id) triple, so a model-variant of the same cell is a distinct target.
function targetKey(
  runtime: string,
  provider: AgentProvider | undefined,
  modelId: string | undefined,
): string {
  return `${runtime}/${provider ?? "-"}:${modelId ?? ""}`;
}

/**
 * Validate every stream's effective fallback chain (spec §6/§7.1 step 2). Each
 * target must be a wired cell, not `rooms`, not a dupe of the primary or an
 * earlier entry, and satisfy the same per-cell structural requirements primaries
 * do — derived from `cellStructuralIssue`, not restated. Structured import
 * failure, same channel as the provider preflight.
 */
function collectFallbackValidationErrors(
  manifest: DriverManifest,
  policy: LoadedDispatchPolicy,
): ManifestParseError[] {
  const errors: ManifestParseError[] = [];
  for (const stream of manifest.batches.flatMap((batch) => batch.streams)) {
    const chain = resolveEffectiveChain(stream, manifest.default_fallback);
    if (chain.length === 0) continue;
    collectStreamFallbackErrors(stream, chain, manifest, policy, errors);
  }
  return errors;
}

function collectStreamFallbackErrors(
  stream: ManifestStream,
  chain: ManifestFallbackTarget[],
  manifest: DriverManifest,
  policy: LoadedDispatchPolicy,
  errors: ManifestParseError[],
): void {
  const label = streamLabel(stream);
  const primaryRuntime = resolveDispatchRuntime(policy, stream.runtime, manifest.default_runtime);
  // A stream with no provider anywhere still dispatches as the engine default,
  // so the dupe seed must name it — else a fallback to that same cell passes.
  const primaryProvider =
    resolveDispatchProvider(policy, stream.provider, manifest.default_provider) ??
    DEFAULT_DISPATCH_PROVIDER;
  const primaryModelId = stream.model_id ?? manifest.default_model_id;
  const seen = new Set<string>([targetKey(primaryRuntime, primaryProvider, primaryModelId)]);
  const ctx = { branchName: stream.branch_name, repoUrl: manifest.repo_url };

  chain.forEach((entry, index) => {
    const at = `stream ${label} fallback[${String(index)}]`;
    const cell = `${entry.runtime}/${entry.provider}`;
    const error = fallbackEntryError(entry, ctx, seen, at, cell);
    if (error !== undefined) errors.push({ message: error });
  });
}

// The first rule `entry` breaks, or undefined when it is a valid, non-duplicate
// target. On success the entry is recorded in `seen` so a later dupe is caught.
function fallbackEntryError(
  entry: ManifestFallbackTarget,
  ctx: { branchName: string | undefined; repoUrl: string | undefined },
  seen: Set<string>,
  at: string,
  cell: string,
): string | undefined {
  if (entry.runtime === "rooms") {
    return `${at}: rooms is not a valid fallback target (${cell})`;
  }
  const issue = cellStructuralIssue({ provider: entry.provider, runtime: entry.runtime }, ctx);
  if (issue !== undefined) {
    return `${at}: ${fallbackMessageForIssue(issue, cell)}`;
  }
  const key = targetKey(entry.runtime, entry.provider, entry.model_id);
  if (seen.has(key)) {
    const suffix = entry.model_id !== undefined ? ` (model_id ${entry.model_id})` : "";
    return `${at}: duplicate fallback target ${cell}${suffix}`;
  }
  seen.add(key);
  return undefined;
}

function fallbackMessageForIssue(issue: CellStructuralIssue, cell: string): string {
  switch (issue) {
    case "unwired-cell":
      return `${cell} is not a wired dispatch cell`;
    case "needs-branch":
      return `${cell} requires branch_name on the stream`;
    case "needs-repo-url":
      return `${cell} requires repo_url in the manifest frontmatter`;
  }
}

/**
 * Advisory (spec §4.4/§7.1 step 3): a chain target whose per-cell credential is
 * absent from `env` gets a run-level warning — import still succeeds, since the
 * env can change before the hop. Deduped by cell so one missing key warns once.
 */
function collectFallbackEnvWarnings(
  manifest: DriverManifest,
  env: Record<string, string | undefined>,
): string[] {
  const seen = new Set<string>();
  const warnings: string[] = [];
  const entries = manifest.batches
    .flatMap((batch) => batch.streams)
    .flatMap((stream) => resolveEffectiveChain(stream, manifest.default_fallback));
  for (const entry of entries) {
    const cell = `${entry.runtime}/${entry.provider}`;
    const missing = missingCredentialEnv({ provider: entry.provider, runtime: entry.runtime }, env);
    if (missing === undefined || seen.has(cell)) continue;
    seen.add(cell);
    warnings.push(
      `fallback target ${cell}: ${missing} not set — the target will be skipped at hop time if still unset`,
    );
  }
  return warnings;
}

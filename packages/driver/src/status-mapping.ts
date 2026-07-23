/**
 * Store stream status → manifest stream status mapping for render.
 *
 * | Store status   | Manifest status |
 * |----------------|-----------------|
 * | pending        | pending         |
 * | dispatching    | in_progress     |
 * | dispatched     | in_progress     |
 * | landed         | in_progress     |
 * | failed         | failed          |
 * | skipped        | skipped         |
 * | done           | done            |
 *
 * Transient dispatch states degrade to `in_progress` because the manifest
 * vocabulary has no dispatch states. Terminal/restable statuses round-trip
 * losslessly through import.
 */

import type {
  DriverStreamStatus,
  FallbackChainTarget,
  FallbackLogRecord,
  TriageTier,
  TriageTierSource,
} from "@ship/store";
import type { AgentProvider } from "@ship/workflow";

import type { EffortTier, ManifestStream, ModelTier } from "./manifest.js";

type ManifestStreamStatus = NonNullable<ManifestStream["status"]>;

/** Maps a store stream status to the manifest frontmatter vocabulary. */
export function storeStatusToManifest(status: DriverStreamStatus): ManifestStreamStatus {
  switch (status) {
    case "dispatching":
    case "dispatched":
    case "landed":
      return "in_progress";
    case "pending":
      return "pending";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
  }
}

/** Maps a manifest stream status to the store vocabulary on import. */
export function manifestStatusToStore(
  status: ManifestStreamStatus | undefined,
): DriverStreamStatus {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "in_progress") return "pending";
  return "pending";
}

/** Maps a store batch status to manifest batch status vocabulary. */
export function storeBatchStatusToManifest(
  status: "pending" | "running" | "done" | "failed",
): "pending" | "running" | "in_progress" | "done" | "failed" {
  if (status === "running") return "running";
  return status;
}

/** Maps manifest batch status to store batch status on import. */
export function manifestBatchStatusToStore(
  status: ManifestBatchStatus | undefined,
  completedAt?: string,
): { status: "pending" | "running" | "done" | "failed"; completedAt?: string } {
  if (status === "done") {
    return completedAt === undefined ? { status: "done" } : { completedAt, status: "done" };
  }
  if (status === "failed") return { status: "failed" };
  return { status: "pending" };
}

type ManifestBatchStatus = "pending" | "running" | "in_progress" | "done" | "failed";

export interface ResolvedStreamTier {
  modelTier?: ModelTier;
  modelId?: string;
  effortTier?: EffortTier;
}

export interface ResolvedStreamProvider {
  provider?: AgentProvider;
}

/** Resolve per-stream tier: stream field > manifest default > none. */
export function resolveStreamTier(
  stream: ManifestStream,
  defaultModel?: ModelTier,
  defaultEffort?: EffortTier,
  defaultModelId?: string,
): ResolvedStreamTier {
  const resolved: ResolvedStreamTier = {};
  const modelTier = stream.model ?? defaultModel;
  const modelId = stream.model_id ?? defaultModelId;
  const effortTier = stream.effort ?? defaultEffort;
  if (modelTier !== undefined) resolved.modelTier = modelTier;
  if (modelId !== undefined) resolved.modelId = modelId;
  if (effortTier !== undefined) resolved.effortTier = effortTier;
  return resolved;
}

/** Resolve per-stream provider: stream field > manifest default > none. */
export function resolveStreamProvider(
  stream: ManifestStream,
  defaultProvider?: AgentProvider,
): ResolvedStreamProvider {
  const resolved: ResolvedStreamProvider = {};
  const provider = stream.provider ?? defaultProvider;
  if (provider !== undefined) resolved.provider = provider;
  return resolved;
}

/** Format tier + dispatch mapping for status diagnostics. */
export function formatStreamTierDiagnostic(stream: {
  modelTier?: ModelTier;
  modelId?: string;
  effortTier?: EffortTier;
  provider?: AgentProvider;
  dispatchProvider?: string;
  dispatchModel?: string;
  dispatchModelParams?: { id: string; value: string | boolean }[];
  effortDegraded?: boolean;
  tierDegradeReason?: string;
}): string | undefined {
  const requested = formatRequestedTier(stream.modelTier, stream.effortTier);
  if (
    requested === undefined &&
    stream.modelId === undefined &&
    stream.provider === undefined &&
    stream.dispatchModel === undefined
  ) {
    return undefined;
  }

  const parts: string[] = [];
  appendRequestedTierPart(parts, requested);
  appendRequestedModelIdPart(parts, stream.modelId);
  appendRequestedProviderPart(parts, stream.provider);
  appendDispatchPart(parts, stream);
  appendDegradeParts(parts, stream);
  return parts.join(" ");
}

function appendRequestedModelIdPart(parts: string[], modelId?: string): void {
  if (modelId === undefined) return;
  parts.push(`model_id=${modelId}`);
}

function appendRequestedProviderPart(parts: string[], provider?: AgentProvider): void {
  if (provider === undefined) return;
  parts.push(`provider=${provider}`);
}

function appendRequestedTierPart(parts: string[], requested: string | undefined): void {
  if (requested === undefined) return;
  parts.push(`requested=${requested}`);
}

function appendDispatchPart(
  parts: string[],
  stream: {
    dispatchProvider?: string;
    dispatchModel?: string;
    dispatchModelParams?: { id: string; value: string | boolean }[];
  },
): void {
  if (stream.dispatchProvider === undefined && stream.dispatchModel === undefined) {
    return;
  }
  const provider = stream.dispatchProvider ?? "cursor";
  const model = stream.dispatchModel ?? "(engine default)";
  parts.push(`dispatch=${provider}/${model}`);
  if (stream.dispatchModelParams === undefined || stream.dispatchModelParams.length === 0) {
    return;
  }
  parts.push(`params=${JSON.stringify(stream.dispatchModelParams)}`);
}

function appendDegradeParts(
  parts: string[],
  stream: { effortDegraded?: boolean; tierDegradeReason?: string },
): void {
  if (stream.effortDegraded === true) {
    parts.push("effortDegraded=true");
  }
  if (stream.tierDegradeReason === undefined) return;
  parts.push(`degrade=${stream.tierDegradeReason}`);
}

function formatRequestedTier(modelTier?: ModelTier, effortTier?: EffortTier): string | undefined {
  if (modelTier === undefined && effortTier === undefined) {
    return undefined;
  }
  const model = modelTier ?? "-";
  const effort = effortTier ?? "-";
  return `${model}/${effort}`;
}

/**
 * Render a stream's fallback log (dispatch-fallback spec §6) — hops, skips, and
 * transient retries — the same first-class treatment `degrade=` gets. Undefined
 * when the log is empty (no chain, or a chain that never hopped), so a stream
 * with nothing to report adds no line. No record is written before P2a, so this
 * renders nothing until the engine hop lands.
 */
export function formatStreamFallbackDiagnostic(
  fallbackLog: FallbackLogRecord[] | undefined,
): string | undefined {
  if (fallbackLog === undefined || fallbackLog.length === 0) {
    return undefined;
  }
  return fallbackLog.map(formatFallbackRecord).join("; ");
}

function formatFallbackRecord(record: FallbackLogRecord): string {
  if ("from" in record) {
    const from = formatFallbackCell(record.from, record.fromModel);
    const to = formatFallbackCell(record.to, record.toModel);
    return `fallback: ${from} → ${to} on ${record.category}`;
  }
  if ("skipped" in record) {
    return `skipped ${formatFallbackCell(record.skipped)}: ${record.reason}`;
  }
  return `retried ${formatFallbackCell(record.retried)} once on ${record.reason}`;
}

function formatFallbackCell(target: FallbackChainTarget, resolvedModel?: string): string {
  const cell = `${target.runtime}/${target.provider}`;
  const model = resolvedModel ?? target.modelId;
  return model === undefined ? cell : `${cell}:${model}`;
}

/**
 * Render a stream's triage-floor classification (review-credit-tiering) for
 * status output — `triage=T1 (classified, head abc1234)` for a classified head,
 * `triage=classifier_error (head abc1234)` for a failed one. Undefined when the
 * stream was never classified (no PR observed yet), so it adds no line. This is
 * the review-risk tier — distinct from the model/effort `requested=`/`dispatch=`
 * line above.
 */
export function formatStreamTriageDiagnostic(stream: {
  triageTier?: TriageTier;
  triageTierSource?: TriageTierSource;
  triageHeadSha?: string;
}): string | undefined {
  if (stream.triageTierSource === undefined) return undefined;
  const head =
    stream.triageHeadSha === undefined ? "" : `, head ${stream.triageHeadSha.slice(0, 7)}`;
  if (stream.triageTierSource === "classified" && stream.triageTier !== undefined) {
    return `triage=${stream.triageTier} (classified${head})`;
  }
  // classifier_error carries no tier — never a fabricated one.
  return `triage=classifier_error (${head === "" ? "no head" : head.replace(/^, /, "")})`;
}

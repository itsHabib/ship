/**
 * Store-backed `WorkflowObservabilityView` projector shared by list and status
 * reads. No filesystem I/O — facts come from workflow rows and cursor_runs only.
 */

import type { WorkflowObservabilityView } from "@ship/mcp";
import type {
  AgentProvider,
  ArtifactRef,
  CursorRunRef,
  CursorRunRuntime,
  ModelSelection,
  Phase,
  WorkflowRun,
} from "@ship/workflow";

import { posix, win32 } from "node:path";

interface RuntimeConfigFields {
  runtime?: CursorRunRuntime;
  provider?: AgentProvider;
  model?: ModelSelection;
}

type ObservabilityTimingFields = Pick<
  WorkflowObservabilityView,
  "startedAt" | "endedAt" | "durationMs"
>;

/** Build the observability projection for one workflow run. */
export function projectWorkflowObservability(
  run: WorkflowRun,
  cursorRun: CursorRunRef | null,
): WorkflowObservabilityView {
  const requested = parseRequestedConfig(run);
  const failure = projectFailure(run);

  if (cursorRun !== null) {
    const actual = extractActualConfig(cursorRun);
    return {
      ...(hasRuntimeConfigFields(requested) && { requested }),
      ...(hasRuntimeConfigFields(actual) && { actual }),
      ...timingFromCursorRun(cursorRun, run),
      evidence: projectEvidence(cursorRun),
      ...(failure !== undefined && { failure }),
    };
  }

  return {
    ...(hasRuntimeConfigFields(requested) && { requested }),
    ...timingFromPhase(implementPhase(run)),
    evidence: { availability: "unknown", reason: "no-cursor-run" },
    ...(failure !== undefined && { failure }),
  };
}

function implementPhase(run: WorkflowRun): Phase | undefined {
  return run.phases.find((phase) => phase.kind === "implement");
}

function parseRequestedConfig(run: WorkflowRun): RuntimeConfigFields {
  const phase = implementPhase(run);
  if (phase === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(phase.inputJson);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const record = parsed as { cloud?: unknown; room?: unknown };
  if (record.cloud !== undefined && record.cloud !== null) {
    return { runtime: "cloud" };
  }
  if (record.room !== undefined && record.room !== null) {
    return { runtime: "rooms" };
  }
  return {};
}

function extractActualConfig(cursorRun: CursorRunRef): RuntimeConfigFields {
  const fields: RuntimeConfigFields = {
    runtime: cursorRun.runtime,
    provider: cursorRun.provider,
  };
  if (cursorRun.model !== undefined) {
    fields.model = cursorRun.model;
  }
  return fields;
}

function hasRuntimeConfigFields(fields: RuntimeConfigFields): boolean {
  return (
    fields.runtime !== undefined || fields.provider !== undefined || fields.model !== undefined
  );
}

function timingFromCursorRun(cursorRun: CursorRunRef, run: WorkflowRun): ObservabilityTimingFields {
  const timing: ObservabilityTimingFields = {
    startedAt: cursorRun.startedAt,
  };
  if (cursorRun.endedAt !== undefined) {
    timing.endedAt = cursorRun.endedAt;
  }
  const durationMs = resolveDurationMs(cursorRun, run);
  if (durationMs !== undefined) {
    timing.durationMs = durationMs;
  }
  return timing;
}

function timingFromPhase(phase: Phase | undefined): ObservabilityTimingFields {
  if (phase === undefined) return {};
  const timing: ObservabilityTimingFields = {};
  if (phase.startedAt !== undefined) {
    timing.startedAt = phase.startedAt;
  }
  if (phase.endedAt !== undefined) {
    timing.endedAt = phase.endedAt;
  }
  const durationMs = durationMsFromTimestamps(phase.startedAt, phase.endedAt);
  if (durationMs !== undefined) {
    timing.durationMs = durationMs;
  }
  return timing;
}

function resolveDurationMs(cursorRun: CursorRunRef, run: WorkflowRun): number | undefined {
  if (cursorRun.durationMs !== undefined) {
    return cursorRun.durationMs;
  }
  const fromCursor = durationMsFromTimestamps(cursorRun.startedAt, cursorRun.endedAt);
  if (fromCursor !== undefined) {
    return fromCursor;
  }
  const phase = implementPhase(run);
  return durationMsFromTimestamps(phase?.startedAt, phase?.endedAt);
}

function durationMsFromTimestamps(
  startedAt: string | undefined,
  endedAt: string | undefined,
): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms === 0) return undefined;
  return ms;
}

function projectFailure(run: WorkflowRun): WorkflowObservabilityView["failure"] | undefined {
  if (run.status !== "failed") return undefined;
  const phase = implementPhase(run);
  if (phase === undefined) return undefined;
  const failure: NonNullable<WorkflowObservabilityView["failure"]> = {};
  if (phase.failureCategory !== undefined) {
    failure.category = phase.failureCategory;
  }
  const detail = sanitizeFailureDetail(phase.errorMessage);
  if (detail !== undefined) {
    failure.detail = detail;
  }
  if (failure.category === undefined && failure.detail === undefined) {
    return undefined;
  }
  return failure;
}

function projectEvidence(
  cursorRun: CursorRunRef,
): NonNullable<WorkflowObservabilityView["evidence"]> {
  const refs = sanitizeEvidenceRefs(cursorRun.artifacts);
  if (refs !== undefined && refs.length > 0) {
    return { availability: "available", refs };
  }
  return {
    availability: "unavailable",
    reason: "no-persisted-artifact-manifest",
  };
}

function sanitizeEvidenceRefs(
  artifacts: readonly ArtifactRef[] | undefined,
): ArtifactRef[] | undefined {
  if (artifacts === undefined || artifacts.length === 0) return undefined;
  const refs: ArtifactRef[] = [];
  for (const artifact of artifacts) {
    if (isAbsolutePath(artifact.path)) continue;
    refs.push({
      path: artifact.path,
      sizeBytes: artifact.sizeBytes,
      updatedAt: artifact.updatedAt,
    });
  }
  return refs.length > 0 ? refs : undefined;
}

export function sanitizeFailureDetail(message: string | undefined): string | undefined {
  if (message === undefined || message.length === 0) return undefined;
  const quoted = message.replace(/(["'])(?:[A-Za-z]:\\|\/)[^"'\r\n]*\1/g, "[path]");
  const redacted = quoted.replace(
    /(^|[\s(,;=])(?:[A-Za-z]:\\|\/).*$/gm,
    (_match, prefix: string) => `${prefix}[path]`,
  );
  const tokenRedacted = redacted
    .replace(/\b(?:ghp_|gho_|github_pat_)\w+/g, "[token]")
    .replace(/\bBearer\s+[\w.-]+/gi, "Bearer [token]")
    .replace(/\bCURSOR_API_KEY=[^\s]+/gi, "CURSOR_API_KEY=[redacted]")
    .replace(/\bGITHUB_TOKEN=[^\s]+/gi, "GITHUB_TOKEN=[redacted]");
  return tokenRedacted.length > 0 ? tokenRedacted : undefined;
}

function isAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

/** Keys that must never appear in a public observability projection. */
export const FORBIDDEN_OBSERVABILITY_KEYS = new Set([
  "artifactsDir",
  "artifacts_dir",
  "username",
  "userName",
  "token",
  "envVars",
  "env",
]);

/** Walk a projection value and collect forbidden key names present at any depth. */
export function collectForbiddenObservabilityKeys(value: unknown): string[] {
  const found = new Set<string>();
  walkObservabilityValue(value, found);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function walkObservabilityValue(value: unknown, found: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkObservabilityValue(entry, found);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_OBSERVABILITY_KEYS.has(key)) {
      found.add(key);
    }
    walkObservabilityValue(nested, found);
  }
}

/** True when a string value looks like an absolute filesystem path. */
export function containsAbsolutePathString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return isAbsolutePath(value);
}

/** Recursively scan for absolute path strings in a projection. */
export function collectAbsolutePathStrings(value: unknown): string[] {
  const found: string[] = [];
  walkAbsolutePaths(value, found);
  return found;
}

function walkAbsolutePaths(value: unknown, found: string[]): void {
  if (typeof value === "string") {
    if (isAbsolutePath(value)) found.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkAbsolutePaths(entry, found);
    }
    return;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    walkAbsolutePaths(nested, found);
  }
}

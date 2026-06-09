// Pure failure classification + bounded detail builder. Exported for
// `core`'s finalize paths; lives in cursor-runner where SDK event shapes are native.

import type { SDKMessage } from "@cursor/sdk";
import type { FailureCategory } from "@ship/workflow";

import { LOCAL_RUN_CONTENTION_HINT } from "@ship/workflow";

import { eventRecord, stringifyToolCallResult } from "./_shared.js";

const NEAR_CAP_DURATION_RATIO = 0.95;
const COLLAPSE_DURATION_RATIO = 0.8;
const RUNNING_TOOL_MIN_AGE_MS = 30_000;
const MAX_FAILURE_DETAIL_CHARS = 512;
const TRUNCATED_SUFFIX = "...";

function boundFailureDetail(text: string): string {
  if (text.length <= MAX_FAILURE_DETAIL_CHARS) return text;
  const keep = MAX_FAILURE_DETAIL_CHARS - TRUNCATED_SUFFIX.length;
  return `${text.slice(0, keep)}${TRUNCATED_SUFFIX}`;
}

export interface ClassifyFailureInput {
  readonly sdkTerminalStatus?: string;
  readonly isStoreContention?: boolean;
  readonly thrownError?: boolean;
  readonly durationMs?: number;
  readonly maxRunDurationMs?: number;
  readonly events: readonly SDKMessage[];
}

export interface BuildFailureDetailInput {
  readonly category: FailureCategory;
  readonly sdkTerminalStatus?: string;
  readonly durationMs?: number;
  readonly maxRunDurationMs?: number;
  readonly events: readonly SDKMessage[];
  readonly rawErrorMessage?: string;
  readonly thrownErr?: unknown;
}

function parseEventTimestamp(raw: Record<string, unknown>): number | undefined {
  const ts = raw["ts"] ?? raw["startedAt"];
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

function lastEventTimestamp(events: readonly SDKMessage[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const ts = parseEventTimestamp(eventRecord(ev));
    if (ts !== undefined) return ts;
  }
  return undefined;
}

function lastFailedToolCallDetail(events: readonly SDKMessage[]): string | undefined {
  let detail: string | undefined;
  for (const ev of events) {
    const raw = eventRecord(ev);
    if (raw["type"] !== "tool_call") continue;
    const status = raw["status"];
    if (status !== "error" && status !== "failed") continue;
    const resultText = stringifyToolCallResult(raw["result"]);
    if (resultText.length > 0) {
      detail = resultText;
      continue;
    }
    const name = typeof raw["name"] === "string" ? raw["name"] : "tool";
    detail = `${name} errored`;
  }
  return detail;
}

function toolCallId(raw: Record<string, unknown>): string | undefined {
  const id = raw["call_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

// Final status per call_id (last event wins) so a tool that emitted `running`
// early but `completed`/`error` later is not counted as still-running.
function finalStatusByCallId(events: readonly SDKMessage[]): Map<string, unknown> {
  const byId = new Map<string, unknown>();
  for (const ev of events) {
    const raw = eventRecord(ev);
    if (raw["type"] !== "tool_call") continue;
    const id = toolCallId(raw);
    if (id !== undefined) byId.set(id, raw["status"]);
  }
  return byId;
}

// The most recent tool_call still running at stream end. A call_id is unfinished
// only if its LAST tool_call event is `running`; calls lacking a call_id can't be
// reconciled and fall back to their own status (last-running-wins).
function lastRunningToolCall(events: readonly SDKMessage[]): Record<string, unknown> | undefined {
  const finalStatus = finalStatusByCallId(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const raw = eventRecord(ev);
    if (raw["type"] !== "tool_call") continue;
    const id = toolCallId(raw);
    const effectiveStatus = id !== undefined ? finalStatus.get(id) : raw["status"];
    if (effectiveStatus === "running") return raw;
  }
  return undefined;
}

function runningToolAgeMs(
  toolCall: Record<string, unknown>,
  events: readonly SDKMessage[],
  durationMs: number | undefined,
): number | undefined {
  const toolTs = parseEventTimestamp(toolCall);
  const endTs = lastEventTimestamp(events);
  if (toolTs !== undefined && endTs !== undefined) {
    const age = endTs - toolTs;
    return age >= 0 ? age : undefined;
  }
  if (durationMs !== undefined && durationMs >= RUNNING_TOOL_MIN_AGE_MS) {
    return durationMs;
  }
  return undefined;
}

// Second-granularity, distinct from _shared's minute-granularity formatter:
// failure detail ("running 45s, never completed") needs finer precision than the
// "after 5m (cap 30m)" run summaries. Intentionally not shared.
function formatWallDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${String(sec)}s`;
  if (sec === 0) return `${String(min)}m`;
  return `${String(min)}m${String(sec)}s`;
}

function isNearCap(durationMs: number | undefined, maxRunDurationMs: number | undefined): boolean {
  if (durationMs === undefined || maxRunDurationMs === undefined) return false;
  return durationMs >= NEAR_CAP_DURATION_RATIO * maxRunDurationMs;
}

function isCollapseDuration(
  durationMs: number | undefined,
  maxRunDurationMs: number | undefined,
): boolean {
  if (durationMs === undefined || maxRunDurationMs === undefined) return false;
  return durationMs > COLLAPSE_DURATION_RATIO * maxRunDurationMs;
}

function normalizeSdkStatus(status: string | undefined): string | undefined {
  if (status === undefined || status.length === 0) return undefined;
  return status.toLowerCase();
}

function isExpiredStatus(status: string | undefined): boolean {
  return normalizeSdkStatus(status) === "expired";
}

function agentCollapseOnRunningTool(input: ClassifyFailureInput): boolean {
  const running = lastRunningToolCall(input.events);
  if (running === undefined) return false;
  if (!isCollapseDuration(input.durationMs, input.maxRunDurationMs)) return false;
  const age = runningToolAgeMs(running, input.events, input.durationMs);
  if (age === undefined) return false;
  return age > RUNNING_TOOL_MIN_AGE_MS;
}

// Maps terminal failure signals to a canonical category. Total — never throws.
export function classifyFailure(input: ClassifyFailureInput): FailureCategory {
  if (input.isStoreContention === true) return "contention";
  if (input.thrownError === true) return "sdk-throw";
  if (lastFailedToolCallDetail(input.events) !== undefined) return "logic";
  if (agentCollapseOnRunningTool(input)) return "agent-collapse-on-running-tool";
  if (isExpiredStatus(input.sdkTerminalStatus)) return "timeout-near-cap";
  if (isNearCap(input.durationMs, input.maxRunDurationMs)) return "timeout-near-cap";
  return "unknown";
}

function thrownErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return undefined;
}

function runningToolDetail(
  toolCall: Record<string, unknown>,
  events: readonly SDKMessage[],
  durationMs: number | undefined,
): string {
  const name = typeof toolCall["name"] === "string" ? toolCall["name"] : "tool";
  const age = runningToolAgeMs(toolCall, events, durationMs) ?? durationMs ?? 0;
  return `last activity: ${name} running ${formatWallDuration(age)}, never completed`;
}

function detailForContention(input: BuildFailureDetailInput): string {
  const fromErr = thrownErrorMessage(input.thrownErr);
  if (fromErr?.includes(LOCAL_RUN_CONTENTION_HINT) === true) return fromErr;
  return LOCAL_RUN_CONTENTION_HINT;
}

function detailForSdkThrow(input: BuildFailureDetailInput): string {
  const fromErr = thrownErrorMessage(input.thrownErr);
  if (fromErr !== undefined) return fromErr;
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  return "SDK error before terminal result";
}

function detailForLogic(input: BuildFailureDetailInput): string {
  const detail = lastFailedToolCallDetail(input.events);
  if (detail !== undefined) return detail;
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  return "tool_call failed";
}

function detailForAgentCollapse(input: BuildFailureDetailInput): string {
  const running = lastRunningToolCall(input.events);
  if (running !== undefined) {
    return runningToolDetail(running, input.events, input.durationMs);
  }
  return "agent stopped with a running tool_call";
}

function detailForTimeoutNearCap(input: BuildFailureDetailInput): string {
  const { durationMs, maxRunDurationMs } = input;
  const capPart =
    maxRunDurationMs !== undefined
      ? `duration ${formatWallDuration(durationMs ?? 0)} (cap ${formatWallDuration(maxRunDurationMs)})`
      : `duration ${formatWallDuration(durationMs ?? 0)}`;
  if (isExpiredStatus(input.sdkTerminalStatus)) {
    return `SDK status expired; ${capPart}`;
  }
  return capPart;
}

function detailForUnknown(input: BuildFailureDetailInput): string {
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  const fromErr = thrownErrorMessage(input.thrownErr);
  if (fromErr !== undefined) return fromErr;
  if (input.sdkTerminalStatus !== undefined && input.sdkTerminalStatus.length > 0) {
    return `SDK status ${input.sdkTerminalStatus}`;
  }
  return "no classification signals";
}

const DETAIL_BUILDERS: Record<FailureCategory, (input: BuildFailureDetailInput) => string> = {
  contention: detailForContention,
  "timeout-near-cap": detailForTimeoutNearCap,
  "agent-collapse-on-running-tool": detailForAgentCollapse,
  "sdk-throw": detailForSdkThrow,
  logic: detailForLogic,
  unknown: detailForUnknown,
};

// Builds a bounded operator-facing detail string for a classified failure.
export function buildFailureDetail(input: BuildFailureDetailInput): string {
  return boundFailureDetail(DETAIL_BUILDERS[input.category](input));
}

export function formatClassifiedErrorMessage(category: FailureCategory, detail: string): string {
  return `${category}; ${detail}`;
}

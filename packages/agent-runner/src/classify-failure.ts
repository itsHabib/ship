// Pure failure classification + bounded detail builder. Reads events through
// an injected `EventProjection` so provider spellings never reach policy.

import type { FailureCategory } from "@ship/workflow";

import { LOCAL_RUN_CONTENTION_HINT } from "@ship/workflow";

import type { AgentEvent, EventProjection } from "./event-projection.js";

import { formatRunningToolAge } from "./formatters.js";
import {
  lastFailedToolCallDetail,
  lastRunningToolCall,
  runningToolAgeMs,
  runningToolDetail,
} from "./projection-helpers.js";

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

export interface ClassifyFailureInput<E = AgentEvent> {
  readonly projection: EventProjection<E>;
  readonly sdkTerminalStatus?: string;
  readonly isStoreContention?: boolean;
  readonly thrownError?: boolean;
  readonly durationMs?: number;
  readonly maxRunDurationMs?: number;
  readonly events: readonly E[];
}

export interface BuildFailureDetailInput<E = AgentEvent> {
  readonly projection: EventProjection<E>;
  readonly category: FailureCategory;
  readonly sdkTerminalStatus?: string;
  readonly durationMs?: number;
  readonly maxRunDurationMs?: number;
  readonly events: readonly E[];
  readonly rawErrorMessage?: string;
  readonly thrownErr?: unknown;
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

function agentCollapseOnRunningTool<E>(input: ClassifyFailureInput<E>): boolean {
  const running = lastRunningToolCall(input.projection, input.events);
  if (running === undefined) return false;
  if (!isCollapseDuration(input.durationMs, input.maxRunDurationMs)) return false;
  const age = runningToolAgeMs(
    input.projection,
    running,
    input.events,
    input.durationMs,
    RUNNING_TOOL_MIN_AGE_MS,
  );
  if (age === undefined) return false;
  return age > RUNNING_TOOL_MIN_AGE_MS;
}

export function classifyFailure<E = AgentEvent>(input: ClassifyFailureInput<E>): FailureCategory {
  if (input.isStoreContention === true) return "contention";
  if (input.thrownError === true) return "sdk-throw";
  if (lastFailedToolCallDetail(input.projection, input.events) !== undefined) return "logic";
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

function detailForContention<E>(input: BuildFailureDetailInput<E>): string {
  const fromErr = thrownErrorMessage(input.thrownErr);
  if (fromErr?.includes(LOCAL_RUN_CONTENTION_HINT) === true) return fromErr;
  return LOCAL_RUN_CONTENTION_HINT;
}

function detailForSdkThrow<E>(input: BuildFailureDetailInput<E>): string {
  const fromErr = thrownErrorMessage(input.thrownErr);
  if (fromErr !== undefined) return fromErr;
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  return "SDK error before terminal result";
}

function detailForLogic<E>(input: BuildFailureDetailInput<E>): string {
  const detail = lastFailedToolCallDetail(input.projection, input.events);
  if (detail !== undefined) return detail;
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  return "tool_call failed";
}

function detailForAgentCollapse<E>(input: BuildFailureDetailInput<E>): string {
  const running = lastRunningToolCall(input.projection, input.events);
  if (running === undefined) return "agent stopped with a running tool_call";
  const age =
    runningToolAgeMs(
      input.projection,
      running,
      input.events,
      input.durationMs,
      RUNNING_TOOL_MIN_AGE_MS,
    ) ??
    input.durationMs ??
    0;
  return runningToolDetail(running, age, formatRunningToolAge);
}

function detailForTimeoutNearCap<E>(input: BuildFailureDetailInput<E>): string {
  const { durationMs, maxRunDurationMs } = input;
  const capPart =
    maxRunDurationMs !== undefined
      ? `duration ${formatRunningToolAge(durationMs ?? 0)} (cap ${formatRunningToolAge(maxRunDurationMs)})`
      : `duration ${formatRunningToolAge(durationMs ?? 0)}`;
  if (isExpiredStatus(input.sdkTerminalStatus)) {
    return `SDK status expired; ${capPart}`;
  }
  return capPart;
}

function detailForUnknown<E>(input: BuildFailureDetailInput<E>): string {
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

function detailForGatewayUnreachable<E>(input: BuildFailureDetailInput<E>): string {
  const fromErr = thrownErrorMessage(input.thrownErr);
  if (fromErr !== undefined) return fromErr;
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  return "gateway unreachable";
}

function detailForBudgetExceeded<E>(input: BuildFailureDetailInput<E>): string {
  if (input.sdkTerminalStatus !== undefined && input.sdkTerminalStatus.length > 0) {
    return `SDK status ${input.sdkTerminalStatus}`;
  }
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  return "configured budget or turn cap exceeded";
}

function detailForSandboxDenial<E>(input: BuildFailureDetailInput<E>): string {
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  return "command blocked by sandbox policy";
}

function detailForPatchApplyFail<E>(input: BuildFailureDetailInput<E>): string {
  if (input.rawErrorMessage !== undefined && input.rawErrorMessage.length > 0) {
    return input.rawErrorMessage;
  }
  return "file patch failed to apply";
}

const DETAIL_BUILDERS: Record<FailureCategory, <E>(input: BuildFailureDetailInput<E>) => string> = {
  contention: detailForContention,
  "timeout-near-cap": detailForTimeoutNearCap,
  "agent-collapse-on-running-tool": detailForAgentCollapse,
  "sdk-throw": detailForSdkThrow,
  "gateway-unreachable": detailForGatewayUnreachable,
  "budget-exceeded": detailForBudgetExceeded,
  "sandbox-denial": detailForSandboxDenial,
  "patch-apply-fail": detailForPatchApplyFail,
  logic: detailForLogic,
  unknown: detailForUnknown,
};

export function buildFailureDetail<E = AgentEvent>(input: BuildFailureDetailInput<E>): string {
  return boundFailureDetail(DETAIL_BUILDERS[input.category](input));
}

export function formatClassifiedErrorMessage(category: FailureCategory, detail: string): string {
  return `${category}; ${detail}`;
}

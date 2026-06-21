/**
 * Shared `RunResult` → `AgentRunResult` mapping used by local and cloud
 * runners (phase 04 — ED-1). Terminal error construction stays cursor-local
 * per ED-4; classification policy lives in `@ship/agent-runner`.
 */

import type { RunResult, SDKMessage, ModelSelection as SdkModelSelection } from "@cursor/sdk";

import {
  attachInputAsRunInput,
  formatRunningToolAge,
  formatWallDuration,
  lastRunningToolCall,
  lastTerminalStatus,
  MAX_CLASSIFICATION_EVENTS,
  stringifyToolCallResult,
  summarizeToolCall,
} from "@ship/agent-runner";
import { LOCAL_RUN_CONTENTION_HINT } from "@ship/workflow";

import type { AgentRunInput, AgentRunResult, CloudRunSpec } from "./runner.js";

import { cursorEventProjection, eventRecord } from "./cursor-event-projection.js";

export { attachInputAsRunInput, MAX_CLASSIFICATION_EVENTS };

export function modelArgFromInput(input: AgentRunInput): SdkModelSelection {
  const params = input.model.params?.map((p) => ({
    id: p.id,
    value: typeof p.value === "boolean" ? String(p.value) : p.value,
  }));
  const out: SdkModelSelection = { id: input.model.id };
  if (params !== undefined) out.params = params;
  return out;
}

export interface MapRunResultOptions {
  readonly events?: readonly SDKMessage[];
}

function withClassificationEvents(
  mapped: AgentRunResult,
  events: readonly SDKMessage[],
): AgentRunResult {
  if (events.length === 0) return mapped;
  return { ...mapped, classificationEvents: events };
}

export function mapRunResult(
  result: RunResult,
  input: AgentRunInput,
  requestedCloudSpec?: CloudRunSpec,
  options?: MapRunResultOptions,
): AgentRunResult {
  const events = options?.events ?? [];
  if (result.status === "finished")
    return mapTerminalResult(result, "succeeded", requestedCloudSpec);
  if (result.status === "cancelled")
    return mapTerminalResult(result, "cancelled", requestedCloudSpec);
  return withClassificationEvents(mapErrorResult(result, input, options), events);
}

type FirstBranch = NonNullable<NonNullable<RunResult["git"]>["branches"]>[number];

function autoCreatePrWarning(
  spec: CloudRunSpec,
  branch: FirstBranch | undefined,
): string | undefined {
  if (spec.autoCreatePR !== true) return undefined;
  const prUrl = branch === undefined ? undefined : branch.prUrl;
  if (prUrl !== undefined && prUrl !== "") return undefined;
  return "autoCreatePR was requested but result.branches[0].prUrl is undefined";
}

function branchExpectedWarning(
  spec: CloudRunSpec,
  branch: FirstBranch | undefined,
): string | undefined {
  if (spec.workOnCurrentBranch === true) return undefined;
  const branchName = branch === undefined ? undefined : branch.branch;
  if (branchName !== undefined && branchName !== "") return undefined;
  return "a new branch was expected (workOnCurrentBranch !== true) but result.branches[0].branch is undefined";
}

function startingRefMismatchWarning(spec: CloudRunSpec, result: RunResult): string | undefined {
  const requested = spec.repos[0].startingRef;
  if (requested === undefined || requested === "") return undefined;
  const reported = (result.git as { readonly ref?: string } | undefined)?.ref;
  if (reported === undefined || reported === "" || requested === reported) return undefined;
  return `startingRef '${requested}' was requested but result.git reports ref '${reported}'`;
}

export function deriveCloudWarnings(spec: CloudRunSpec | undefined, result: RunResult): string[] {
  if (spec === undefined) return [];
  const branch = result.git?.branches[0];
  const candidates = [
    autoCreatePrWarning(spec, branch),
    branchExpectedWarning(spec, branch),
    startingRefMismatchWarning(spec, result),
  ];
  return candidates.filter((w): w is string => w !== undefined);
}

export function mapTerminalResult(
  result: RunResult,
  status: "succeeded" | "cancelled",
  requestedCloudSpec?: CloudRunSpec,
): AgentRunResult {
  const warnings = status === "succeeded" ? deriveCloudWarnings(requestedCloudSpec, result) : [];
  return {
    branches: result.git?.branches ?? [],
    ...(warnings.length > 0 && { warnings }),
    durationMs: result.durationMs ?? 0,
    ...(result.model !== undefined && { model: result.model }),
    status,
    ...(result.result !== undefined && { summary: result.result }),
  };
}

function runningToolActivityDetail(
  toolCall: {
    readonly name: string | undefined;
    readonly command: string | undefined;
    readonly timestamp: number | undefined;
  },
  events: readonly SDKMessage[],
): string {
  const summary = summarizeToolCall(toolCall.name, toolCall.command);
  const toolTs = toolCall.timestamp;
  let endTs: number | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const raw = eventRecord(ev);
    const ts = raw["ts"] ?? raw["startedAt"];
    if (typeof ts === "string" && ts.length > 0) {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms)) {
        endTs = ms;
        break;
      }
    }
  }
  if (toolTs === undefined || endTs === undefined) {
    return `last activity: ${summary} running, never completed`;
  }
  const age = endTs - toolTs;
  if (age < 0) return `last activity: ${summary} running, never completed`;
  return `last activity: ${summary} running ${formatRunningToolAge(age)}, never completed`;
}

function toolCallErrorDetail(raw: Record<string, unknown>): string | undefined {
  const status = raw["status"];
  if (status !== "error" && status !== "failed") return undefined;
  const resultText = stringifyToolCallResult(raw["result"]);
  if (resultText.length > 0) return resultText;
  const name = typeof raw["name"] === "string" ? raw["name"] : "tool";
  return `${name} errored`;
}

function statusEventMessageDetail(raw: Record<string, unknown>): string | undefined {
  const status = raw["status"];
  if (status !== "ERROR" && status !== "EXPIRED" && status !== "CANCELLED") return undefined;
  const message = raw["message"];
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

interface EventErrorDetail {
  readonly text: string;
  readonly source: "tool_call" | "status";
}

function errorDetailFromEvent(ev: SDKMessage): EventErrorDetail | undefined {
  const raw = eventRecord(ev);
  if (raw["type"] === "tool_call") {
    const text = toolCallErrorDetail(raw);
    return text === undefined ? undefined : { text, source: "tool_call" };
  }
  if (raw["type"] === "status") {
    const text = statusEventMessageDetail(raw);
    return text === undefined ? undefined : { text, source: "status" };
  }
  return undefined;
}

function lastErrorDetailFromEvents(events: readonly SDKMessage[]): EventErrorDetail | undefined {
  let toolCall: EventErrorDetail | undefined;
  let statusMessage: EventErrorDetail | undefined;
  for (const ev of events) {
    const detail = errorDetailFromEvent(ev);
    if (detail === undefined) continue;
    if (detail.source === "tool_call") toolCall = detail;
    if (detail.source === "status") statusMessage = detail;
  }
  return toolCall ?? statusMessage;
}

function isSqliteLockText(text: string): boolean {
  return /database is locked/i.test(text) || /SQLITE_BUSY/i.test(text);
}

export function withLocalRunContentionHint(message: string): string {
  if (!isSqliteLockText(message)) return message;
  if (message.includes(LOCAL_RUN_CONTENTION_HINT)) return message;
  return `${LOCAL_RUN_CONTENTION_HINT} (${message})`;
}

function sdkStatusErrorMessage(
  displayStatus: string,
  durationPart: string,
  events: readonly SDKMessage[],
): string {
  const running = lastRunningToolCall(cursorEventProjection, events);
  if (running !== undefined) {
    return withLocalRunContentionHint(
      `SDK status ${displayStatus} ${durationPart}; ${runningToolActivityDetail(running, events)}`,
    );
  }
  return `SDK status ${displayStatus} ${durationPart}`;
}

export function buildTerminalErrorMessage(
  result: RunResult,
  events: readonly SDKMessage[],
  maxRunDurationMs?: number,
): string {
  if (result.result !== undefined && result.result !== "") {
    return withLocalRunContentionHint(result.result);
  }
  const eventStatus = lastTerminalStatus(cursorEventProjection, events);
  const displayStatus = (eventStatus ?? result.status).toUpperCase();
  const durationMs = result.durationMs ?? 0;
  const durationPart =
    maxRunDurationMs !== undefined
      ? `after ${formatWallDuration(durationMs)} (cap ${formatWallDuration(maxRunDurationMs)})`
      : `after ${formatWallDuration(durationMs)}`;
  const detail = lastErrorDetailFromEvents(events);
  if (detail !== undefined) {
    const label = detail.source === "tool_call" ? "last tool_call errored" : "detail";
    return withLocalRunContentionHint(
      `SDK status ${displayStatus} ${durationPart}; ${label}: ${detail.text}`,
    );
  }
  if (eventStatus !== undefined || result.status === "error") {
    return sdkStatusErrorMessage(displayStatus, durationPart, events);
  }
  return "Cursor SDK reported error without a message";
}

export function mapErrorResult(
  result: RunResult,
  input: AgentRunInput,
  options?: MapRunResultOptions,
): AgentRunResult {
  const events = options?.events ?? [];
  const sdkTerminalStatus = lastTerminalStatus(cursorEventProjection, events) ?? result.status;
  return {
    branches: result.git?.branches ?? [],
    durationMs: result.durationMs ?? 0,
    model: result.model ?? input.model,
    errorMessage: buildTerminalErrorMessage(result, events, input.maxRunDurationMs),
    sdkTerminalStatus,
    status: "failed",
  };
}

export { eventRecord };

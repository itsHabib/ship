/**
 * Shared `RunResult` → `CursorRunResult` mapping used by local and cloud
 * runners (phase 04 — ED-1).
 */

import type { RunResult, SDKMessage, ModelSelection as SdkModelSelection } from "@cursor/sdk";

import { LOCAL_RUN_CONTENTION_HINT } from "@ship/workflow";

import type {
  CloudRunSpec,
  CursorRunAttachInput,
  CursorRunInput,
  CursorRunResult,
} from "./runner.js";

/**
 * Project a `CursorRunAttachInput` onto the `CursorRunInput` shape so the
 * shared post-`agent.send` pipeline (`#buildHandle` in the runners) can be
 * reused on the attach path. `prompt` and `cwd` are empty because the
 * pipeline doesn't re-issue a prompt — the agent is already running. The
 * `runtime` discriminator is set by the caller: `CloudCursorRunner` passes
 * `"cloud"` so downstream warnings can derive cloud-divergence; the fake
 * leaves it undefined (matching the runner's run-path treatment of
 * `CursorRunInput.runtime` as optional with local default).
 */
export function attachInputAsRunInput(
  input: CursorRunAttachInput,
  runtime?: "local" | "cloud",
): CursorRunInput {
  return {
    cwd: "",
    model: input.model,
    onEvent: input.onEvent,
    prompt: "",
    ...(runtime !== undefined && { runtime }),
    ...(input.cloud !== undefined && { cloud: input.cloud }),
    ...(input.agents !== undefined && { agents: input.agents }),
    ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
    ...(input.signal !== undefined && { signal: input.signal }),
    ...(input.log !== undefined && { log: input.log }),
  };
}

/** Coerce workflow model params to SDK string values (cloud API rejects booleans). */
export function modelArgFromInput(input: CursorRunInput): SdkModelSelection {
  const params = input.model.params?.map((p) => ({
    id: p.id,
    value: typeof p.value === "boolean" ? String(p.value) : p.value,
  }));
  const out: SdkModelSelection = { id: input.model.id };
  if (params !== undefined) out.params = params;
  return out;
}

// Cloud spec is forwarded by the cloud runner only — local-runner deliberately
// omits it so a `CursorRunInput.cloud` carried by a local-runtime caller never
// triggers cloud-divergence warnings on the persisted result.
export interface MapRunResultOptions {
  readonly events?: readonly SDKMessage[];
}

function withClassificationEvents(
  mapped: CursorRunResult,
  events: readonly SDKMessage[],
): CursorRunResult {
  if (events.length === 0) return mapped;
  return { ...mapped, classificationEvents: events };
}

export function mapRunResult(
  result: RunResult,
  input: CursorRunInput,
  requestedCloudSpec?: CloudRunSpec,
  options?: MapRunResultOptions,
): CursorRunResult {
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
  // Cloud RunResult may surface `git.ref`; SDK typings only declare `branches` today.
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

// Shared shape for finished / cancelled — same field set, different status tag.
// Cloud-runner wraps this and emits the debug log itself; local-runner doesn't.
// Keeping the debug call out of here preserves the SHIP_CLOUD_DEBUG-only intent.
export function mapTerminalResult(
  result: RunResult,
  status: "succeeded" | "cancelled",
  requestedCloudSpec?: CloudRunSpec,
): CursorRunResult {
  // Cancelled runs are noisy by construction — no branch / no PR is expected,
  // so the divergence warnings would be uniformly false-positive. Only derive
  // warnings on succeeded terminal state.
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

function formatWallDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 60) return `${String(totalMin)}m`;
  const hours = Math.floor(totalMin / 60);
  const rem = totalMin % 60;
  return rem > 0 ? `${String(hours)}h${String(rem)}m` : `${String(hours)}h`;
}

// Second-granularity formatter for in-flight tool_call age in error/detail text.
function formatRunningToolAge(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${String(sec)}s`;
  if (sec === 0) return `${String(min)}m`;
  return `${String(min)}m${String(sec)}s`;
}

const TOOL_COMMAND_SUMMARY_MAX = 80;

// Parse an SDK event timestamp from `ts` or `startedAt`.
export function parseEventTimestamp(raw: Record<string, unknown>): number | undefined {
  const ts = raw["ts"] ?? raw["startedAt"];
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

// Most recent event timestamp in the stream.
export function lastEventTimestamp(events: readonly SDKMessage[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const ts = parseEventTimestamp(eventRecord(ev));
    if (ts !== undefined) return ts;
  }
  return undefined;
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
export function lastRunningToolCall(
  events: readonly SDKMessage[],
): Record<string, unknown> | undefined {
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

function commandLikeFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const command = record["command"];
  if (typeof command === "string" && command.length > 0) return command;
  return undefined;
}

function truncateCommandSummary(command: string): string {
  if (command.length <= TOOL_COMMAND_SUMMARY_MAX) return command;
  const keep = TOOL_COMMAND_SUMMARY_MAX - 3;
  return `${command.slice(0, keep)}...`;
}

// Render a tool_call name plus an optional quoted command from unstable `args`.
export function summarizeToolCall(raw: Record<string, unknown>): string {
  const name = typeof raw["name"] === "string" ? raw["name"] : "tool";
  const command = commandLikeFromArgs(raw["args"]);
  if (command === undefined) return name;
  return `${name} '${truncateCommandSummary(command)}'`;
}

function runningToolAgeFromTimestamps(
  toolCall: Record<string, unknown>,
  events: readonly SDKMessage[],
): number | undefined {
  const toolTs = parseEventTimestamp(toolCall);
  const endTs = lastEventTimestamp(events);
  if (toolTs === undefined || endTs === undefined) return undefined;
  const age = endTs - toolTs;
  return age >= 0 ? age : undefined;
}

// Bounded in-flight tool_call detail for terminal error messages and failure detail.
export function runningToolActivityDetail(
  toolCall: Record<string, unknown>,
  events: readonly SDKMessage[],
): string {
  const summary = summarizeToolCall(toolCall);
  const age = runningToolAgeFromTimestamps(toolCall, events);
  if (age === undefined) return `last activity: ${summary} running, never completed`;
  return `last activity: ${summary} running ${formatRunningToolAge(age)}, never completed`;
}

// Upper bound on the streamed events retained for failure classification. Both
// runners keep the most-recent window; the fake mirrors it so tests reflect the
// same eviction. Single source of truth so the three stay aligned.
export const MAX_CLASSIFICATION_EVENTS = 256;

// Shared by the runners and the failure classifier — kept here so both read
// SDK event shapes through one projection.
export function eventRecord(ev: SDKMessage): Record<string, unknown> {
  return ev as unknown as Record<string, unknown>;
}

export function stringifyToolCallResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
    return String(result);
  }
  if (result === undefined || result === null) return "";
  // JSON.stringify returns undefined for function/symbol; handle explicitly so
  // the stringify below always yields a string for the remaining object case.
  if (typeof result === "function" || typeof result === "symbol") return "tool_call error";
  try {
    return JSON.stringify(result);
  } catch {
    return "tool_call error";
  }
}

function toolCallErrorDetail(raw: Record<string, unknown>): string | undefined {
  const status = raw["status"];
  if (status !== "error" && status !== "failed") return undefined;
  const resultText = stringifyToolCallResult(raw["result"]);
  if (resultText.length > 0) return resultText;
  const name = typeof raw["name"] === "string" ? raw["name"] : "tool";
  return `${name} errored`;
}

// A status event's free-text `message`, if present. The status enum itself
// (e.g. "ERROR") is intentionally NOT returned: it is already surfaced via the
// SDK-status line, and returning it would let the terminal status event clobber
// the more specific tool_call detail it follows.
function statusEventMessageDetail(raw: Record<string, unknown>): string | undefined {
  const status = raw["status"];
  if (status !== "ERROR" && status !== "EXPIRED" && status !== "CANCELLED") return undefined;
  const message = raw["message"];
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

// The error detail a single event carries, tagged with its source so the caller
// can prefer the specific tool_call cause over a coarser status message.
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

function lastSdkStatusFromEvents(events: readonly SDKMessage[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const raw = eventRecord(ev);
    if (raw["type"] === "status" && typeof raw["status"] === "string") {
      return raw["status"];
    }
  }
  return undefined;
}

// Prefer the last failed tool_call's detail (the actionable cause, e.g.
// "database is locked") over a status message, regardless of stream order — the
// terminal status:ERROR naturally follows the tool_call error and must not win.
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

/** Prefix SDK/SQLite lock failures with the operator-facing contention hint. */
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
  const running = lastRunningToolCall(events);
  if (running !== undefined) {
    return withLocalRunContentionHint(
      `SDK status ${displayStatus} ${durationPart}; ${runningToolActivityDetail(running, events)}`,
    );
  }
  return `SDK status ${displayStatus} ${durationPart}`;
}

/** Fold SDK terminal state + streamed events into a single operator-facing message. */
export function buildTerminalErrorMessage(
  result: RunResult,
  events: readonly SDKMessage[],
  maxRunDurationMs?: number,
): string {
  if (result.result !== undefined && result.result !== "") {
    return withLocalRunContentionHint(result.result);
  }
  const eventStatus = lastSdkStatusFromEvents(events);
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

// Failed runs carry an errorMessage; the SDK's `result` is the agent's
// last text, used as the message when present.
export function mapErrorResult(
  result: RunResult,
  input: CursorRunInput,
  options?: MapRunResultOptions,
): CursorRunResult {
  const events = options?.events ?? [];
  const sdkTerminalStatus = lastSdkStatusFromEvents(events) ?? result.status;
  return {
    branches: result.git?.branches ?? [],
    durationMs: result.durationMs ?? 0,
    model: result.model ?? input.model,
    errorMessage: buildTerminalErrorMessage(result, events, input.maxRunDurationMs),
    sdkTerminalStatus,
    status: "failed",
  };
}

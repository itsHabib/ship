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

export function mapRunResult(
  result: RunResult,
  input: CursorRunInput,
  requestedCloudSpec?: CloudRunSpec,
  options?: MapRunResultOptions,
): CursorRunResult {
  if (result.status === "finished")
    return mapTerminalResult(result, "succeeded", requestedCloudSpec);
  if (result.status === "cancelled")
    return mapTerminalResult(result, "cancelled", requestedCloudSpec);
  return mapErrorResult(result, input, options);
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

function eventRecord(ev: SDKMessage): Record<string, unknown> {
  return ev as unknown as Record<string, unknown>;
}

function stringifyToolCallResult(result: unknown): string {
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
    return `SDK status ${displayStatus} ${durationPart}`;
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

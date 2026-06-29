/**
 * Cloud (Managed Agents) stream-event reducer → `AgentRunResult`.
 * Terminal detection reads session status events directly; no EventProjection.
 * Provider-local — the cursor/local classify-failure seam is NOT used here.
 */

import type { AgentRunResult } from "@ship/agent-runner";
import type { FailureCategory } from "@ship/workflow";

import { MAX_CLASSIFICATION_EVENTS } from "@ship/agent-runner";

import type { CloudErrorEvent, CloudStreamEvent } from "./cloud-session.js";

// Network / gateway error heuristics mirroring the local runner's classify-failure.
const GATEWAY_ERR_RE = /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed/i;
// Server-side HTTP status on an SDK error object. 5xx (bad gateway / unavailable
// / timeout / upstream) maps to gateway-unreachable; 4xx client errors (auth,
// validation, not-found) are real failures and stay sdk-throw.
function hasGatewayStatus(err: unknown): boolean {
  if (err === null || typeof err !== "object" || !("status" in err)) return false;
  const status: unknown = err.status;
  return typeof status === "number" && status >= 500 && status < 600;
}

function isGatewayError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (GATEWAY_ERR_RE.test(msg)) return true;
  // Beta-header-stripped 400 from a gateway that doesn't forward anthropic-beta.
  if (/\b400\b/.test(msg) && /beta|header/i.test(msg)) return true;
  return hasGatewayStatus(err);
}

function errorTypeToCategory(errorType: string): FailureCategory {
  switch (errorType) {
    case "billing_error":
      return "budget-exceeded";
    case "model_overloaded_error":
    case "model_rate_limited_error":
    case "model_request_failed_error":
    case "credential_host_unreachable_error":
    case "mcp_connection_failed_error":
    case "mcp_authentication_failed_error":
      return "gateway-unreachable";
    case "unknown_error":
    default:
      return "sdk-throw";
  }
}

// Mutable reducer accumulator. Mutation lives in methods (`this.*`) rather than
// callers reassigning fields, so the free `detectTerminal` reducer doesn't trip
// `no-param-reassign`. Fields stay publicly readable for tests + the summary read.
export class CloudTerminalState {
  lastError: CloudErrorEvent | undefined = undefined;
  readonly agentMessageParts: string[] = [];

  recordError(ev: CloudErrorEvent): void {
    this.lastError = ev;
  }

  addMessage(text: string): void {
    if (text.length > 0) this.agentMessageParts.push(text);
  }
}

export function newCloudTerminalState(): CloudTerminalState {
  return new CloudTerminalState();
}

/**
 * Feed a stream event into the terminal detector.
 * Returns an `AgentRunResult` on the first terminal signal, `undefined` otherwise.
 * Mutates `state` (last error context + summary accumulation).
 */
export function detectTerminal(
  state: CloudTerminalState,
  ev: CloudStreamEvent,
  wallMs: number,
  capturedEvents: readonly unknown[],
): AgentRunResult | undefined {
  if (ev.type === "session.error") {
    state.recordError(ev);
    return undefined;
  }
  if (ev.type === "agent.message") {
    // Defensive: cast to a loose block shape so the text-type guard is a real
    // runtime check (the typed `content` is text-only, but the API may evolve).
    const text = (ev.content as readonly { type?: string; text?: string }[])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    state.addMessage(text);
    return undefined;
  }
  if (ev.type === "session.status_idle") {
    return mapIdleEvent(state, ev.stop_reason, wallMs, capturedEvents);
  }
  if (ev.type === "session.status_terminated") {
    return mapTerminatedEvent(state, wallMs, capturedEvents);
  }
  if (ev.type === "session.deleted") {
    return failResult(
      "stream-ended-without-terminal",
      state.lastError !== undefined ? errorTypeToCategory(state.lastError.error.type) : "sdk-throw",
      `Stream ended without terminal session status (session.deleted)`,
      wallMs,
      capturedEvents,
    );
  }
  return undefined;
}

function mapIdleEvent(
  state: CloudTerminalState,
  stopReason: { readonly type: string },
  wallMs: number,
  capturedEvents: readonly unknown[],
): AgentRunResult {
  if (stopReason.type === "end_turn") {
    const summary = state.agentMessageParts.join("\n\n").trim();
    return {
      branches: [],
      durationMs: wallMs,
      status: "succeeded",
      ...(summary.length > 0 && { summary }),
    };
  }
  if (stopReason.type === "retries_exhausted") {
    return failResult(
      "session.status_idle:retries_exhausted",
      "budget-exceeded",
      "Session retries exhausted (budget exceeded)",
      wallMs,
      capturedEvents,
    );
  }
  // requires_action — should not occur with an all-always_allow toolset
  return failResult(
    "session.status_idle:requires_action",
    "unknown",
    "Session requires action (unattended; tool confirmation blocked)",
    wallMs,
    capturedEvents,
  );
}

function mapTerminatedEvent(
  state: CloudTerminalState,
  wallMs: number,
  capturedEvents: readonly unknown[],
): AgentRunResult {
  const category =
    state.lastError !== undefined ? errorTypeToCategory(state.lastError.error.type) : "unknown";
  const message =
    state.lastError !== undefined
      ? state.lastError.error.message
      : "Session terminated without prior error context";
  return failResult("session.status_terminated", category, message, wallMs, capturedEvents);
}

/** Call when the stream ends cleanly without a terminal session-status event. */
export function mapCloudStreamEnded(
  state: CloudTerminalState,
  wallMs: number,
  capturedEvents: readonly unknown[],
): AgentRunResult {
  return failResult(
    "stream-ended-without-terminal",
    state.lastError !== undefined ? errorTypeToCategory(state.lastError.error.type) : "sdk-throw",
    "Stream ended without a terminal session status",
    wallMs,
    capturedEvents,
  );
}

/** Call when the stream itself throws (transport/gateway failure). */
export function mapCloudStreamThrow(
  err: unknown,
  wallMs: number,
  capturedEvents: readonly unknown[],
): AgentRunResult {
  const msg = err instanceof Error ? err.message : String(err);
  const category: FailureCategory = isGatewayError(err) ? "gateway-unreachable" : "sdk-throw";
  return failResult("stream-throw", category, msg, wallMs, capturedEvents);
}

function failResult(
  sdkTerminalStatus: string,
  failureCategory: FailureCategory,
  errorMessage: string,
  durationMs: number,
  capturedEvents: readonly unknown[],
): AgentRunResult {
  return {
    branches: [],
    classificationEvents: capturedEvents.slice(-MAX_CLASSIFICATION_EVENTS),
    durationMs,
    errorMessage,
    failureCategory,
    sdkTerminalStatus,
    status: "failed",
  };
}

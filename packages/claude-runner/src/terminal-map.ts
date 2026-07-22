/**
 * Provider-local `SDKResultMessage` → `AgentRunResult` mapping (spec §6 ED-4).
 */

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunInput, AgentRunResult, AgentRunUsage } from "@ship/agent-runner";

import { MAX_CLASSIFICATION_EVENTS } from "@ship/agent-runner";

import {
  buildFailureDetail,
  classifyFailure,
  type ClaudeBuildFailureDetailInput,
  type ClaudeClassifyFailureInput,
} from "./classify-failure.js";
import { claudeEventProjection } from "./claude-event-projection.js";

export { MAX_CLASSIFICATION_EVENTS };

function liftClaudeUsage(
  msg: Extract<SDKResultMessage, { subtype: "success" }>,
): AgentRunUsage | undefined {
  const usage = msg.usage;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheCreate = usage.cache_creation_input_tokens;
  const totalTokens = inputTokens + outputTokens + cacheRead + cacheCreate;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function resultErrors(msg: SDKResultMessage): string[] {
  if (msg.subtype === "success") return [];
  return msg.errors;
}

function terminalReasonSuffix(msg: SDKResultMessage): string {
  if (msg.subtype === "success") return "";
  const reason = msg.terminal_reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "";
}

function synthesizeErrorMessage(events: readonly SDKMessage[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const text = claudeEventProjection.resultText(ev);
    if ((text ?? "").length > 0) return text;
  }
  return undefined;
}

function classifyInput(
  input: AgentRunInput,
  events: readonly SDKMessage[],
  sdkTerminalStatus: string,
  durationMs: number,
): ClaudeClassifyFailureInput {
  return {
    durationMs,
    events,
    ...(input.maxRunDurationMs !== undefined && { maxRunDurationMs: input.maxRunDurationMs }),
    sdkTerminalStatus,
  };
}

interface FailureDetailArgs {
  readonly input: AgentRunInput;
  readonly events: readonly SDKMessage[];
  readonly category: ReturnType<typeof classifyFailure>;
  readonly sdkTerminalStatus: string;
  readonly durationMs: number;
  readonly rawErrorMessage: string;
  readonly thrownErr?: unknown;
}

function detailInput(args: FailureDetailArgs): ClaudeBuildFailureDetailInput {
  return {
    category: args.category,
    durationMs: args.durationMs,
    events: args.events,
    ...(args.input.maxRunDurationMs !== undefined && {
      maxRunDurationMs: args.input.maxRunDurationMs,
    }),
    rawErrorMessage: args.rawErrorMessage,
    sdkTerminalStatus: args.sdkTerminalStatus,
    ...(args.thrownErr !== undefined && { thrownErr: args.thrownErr }),
  };
}

export function buildTerminalErrorMessage(
  msg: Extract<
    SDKResultMessage,
    {
      subtype:
        | "error_during_execution"
        | "error_max_turns"
        | "error_max_budget_usd"
        | "error_max_structured_output_retries";
    }
  >,
  events: readonly SDKMessage[],
): string {
  const joined = resultErrors(msg).join("; ");
  const reason = terminalReasonSuffix(msg);
  const parts = [joined, reason].filter((part) => part.length > 0);
  if (parts.length > 0) return parts.join("; ");
  const synthesized = synthesizeErrorMessage(events);
  if (synthesized !== undefined) return synthesized;
  return `Claude SDK reported ${msg.subtype} without a message`;
}

export function mapResultMessage(
  msg: SDKResultMessage,
  input: AgentRunInput,
  events: readonly SDKMessage[],
): AgentRunResult {
  // The SDK reports fractional wall time; durationMs flows into the result.json
  // artifact, the cursor_runs int column, and the MCP `.int()` diagnostics
  // schema. Round once at the source so every downstream consumer sees a whole
  // millisecond — success and failure alike (a failed terminal's artifact is
  // read back by loadRunDiagnostics, so it must be normalized too).
  const durationMs = Math.round(msg.duration_ms);
  if (msg.subtype === "success") {
    const usage = liftClaudeUsage(msg);
    return {
      branches: [],
      durationMs,
      status: "succeeded",
      summary: msg.result,
      ...(usage !== undefined && { usage }),
      ...(typeof msg.total_cost_usd === "number" && { costUsd: msg.total_cost_usd }),
    };
  }

  const errorMessage = buildTerminalErrorMessage(msg, events);
  const failureCategory = classifyFailure(classifyInput(input, events, msg.subtype, durationMs));
  const failureDetail = buildFailureDetail(
    detailInput({
      category: failureCategory,
      durationMs,
      events,
      input,
      rawErrorMessage: errorMessage,
      sdkTerminalStatus: msg.subtype,
    }),
  );

  return {
    branches: [],
    classificationEvents: events.slice(-MAX_CLASSIFICATION_EVENTS),
    durationMs,
    failureCategory,
    failureDetail,
    errorMessage,
    sdkTerminalStatus: msg.subtype,
    status: "failed",
  };
}

export function mapMidStreamFailure(
  err: unknown,
  input: AgentRunInput,
  events: readonly SDKMessage[],
): AgentRunResult {
  const rawErrorMessage = err instanceof Error ? err.message : String(err);
  const failureCategory = classifyFailure({
    durationMs: 0,
    events,
    ...(input.maxRunDurationMs !== undefined && { maxRunDurationMs: input.maxRunDurationMs }),
    sdkTerminalStatus: "stream-throw",
    thrownErr: err,
    thrownError: true,
  });
  const failureDetail = buildFailureDetail(
    detailInput({
      category: failureCategory,
      durationMs: 0,
      events,
      input,
      rawErrorMessage,
      sdkTerminalStatus: "stream-throw",
      thrownErr: err,
    }),
  );
  return {
    branches: [],
    classificationEvents: events.slice(-MAX_CLASSIFICATION_EVENTS),
    durationMs: 0,
    failureCategory,
    failureDetail,
    errorMessage: rawErrorMessage,
    sdkTerminalStatus: "stream-throw",
    status: "failed",
  };
}

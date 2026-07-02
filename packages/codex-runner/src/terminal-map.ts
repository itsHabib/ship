/**
 * Provider-local `ThreadEvent` drain → `AgentRunResult` mapping (spec §6 ED-4).
 */

import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentRunInput, AgentRunResult, AgentRunUsage } from "@ship/agent-runner";

import { MAX_CLASSIFICATION_EVENTS } from "@ship/agent-runner";

import {
  buildFailureDetail,
  classifyFailure,
  type CodexBuildFailureDetailInput,
  type CodexClassifyFailureInput,
} from "./classify-failure.js";
import { codexEventProjection } from "./codex-event-projection.js";

export { MAX_CLASSIFICATION_EVENTS };

function liftCodexUsage(
  terminal: Extract<ThreadEvent, { type: "turn.completed" }>,
): AgentRunUsage | undefined {
  const usage = terminal.usage;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cachedInput = usage.cached_input_tokens;
  const reasoningOutput = usage.reasoning_output_tokens;
  const totalTokens = inputTokens + outputTokens + cachedInput + reasoningOutput;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function synthesizeErrorMessage(events: readonly ThreadEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const text = codexEventProjection.resultText(ev);
    if (text !== undefined && text.length > 0) return text;
  }
  return undefined;
}

function lastAgentMessageText(events: readonly ThreadEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.type !== "item.started" && ev.type !== "item.updated" && ev.type !== "item.completed") {
      continue;
    }
    if (ev.item.type !== "agent_message") continue;
    if (ev.item.text.length > 0) return ev.item.text;
  }
  return undefined;
}

function terminalErrorMessage(terminal: ThreadEvent, events: readonly ThreadEvent[]): string {
  const fromProjection = codexEventProjection.resultText(terminal);
  if (fromProjection !== undefined && fromProjection.length > 0) return fromProjection;
  const synthesized = synthesizeErrorMessage(events);
  if (synthesized !== undefined) return synthesized;
  const status = codexEventProjection.terminalStatus(terminal);
  return `Codex reported ${status ?? "failure"} without a message`;
}

function classifyInput(
  input: AgentRunInput,
  events: readonly ThreadEvent[],
  sdkTerminalStatus: string,
  durationMs: number,
  rawErrorMessage?: string,
): CodexClassifyFailureInput {
  return {
    durationMs,
    events,
    ...(input.maxRunDurationMs !== undefined && { maxRunDurationMs: input.maxRunDurationMs }),
    ...(rawErrorMessage !== undefined && { rawErrorMessage }),
    sdkTerminalStatus,
  };
}

interface FailureDetailArgs {
  readonly input: AgentRunInput;
  readonly events: readonly ThreadEvent[];
  readonly category: ReturnType<typeof classifyFailure>;
  readonly sdkTerminalStatus: string;
  readonly durationMs: number;
  readonly rawErrorMessage: string;
  readonly thrownErr?: unknown;
}

function detailInput(args: FailureDetailArgs): CodexBuildFailureDetailInput {
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

function failedResult(args: FailureDetailArgs): AgentRunResult {
  const failureCategory = args.category;
  const failureDetail = buildFailureDetail(detailInput(args));
  return {
    branches: [],
    classificationEvents: args.events.slice(-MAX_CLASSIFICATION_EVENTS),
    durationMs: args.durationMs,
    failureCategory,
    failureDetail,
    errorMessage: args.rawErrorMessage,
    sdkTerminalStatus: args.sdkTerminalStatus,
    status: "failed",
  };
}

export function mapTerminalEvent(
  terminal: ThreadEvent,
  input: AgentRunInput,
  events: readonly ThreadEvent[],
  durationMs: number,
): AgentRunResult {
  const sdkTerminalStatus = codexEventProjection.terminalStatus(terminal);
  if (sdkTerminalStatus === "turn.completed") {
    const summary = lastAgentMessageText(events) ?? "";
    const usage = liftCodexUsage(terminal as Extract<ThreadEvent, { type: "turn.completed" }>);
    return {
      branches: [],
      durationMs,
      status: "succeeded",
      summary,
      ...(usage !== undefined && { usage }),
    };
  }

  const errorMessage = terminalErrorMessage(terminal, events);
  const failureCategory = classifyFailure(
    classifyInput(input, events, sdkTerminalStatus ?? "unknown", durationMs, errorMessage),
  );
  return failedResult({
    category: failureCategory,
    durationMs,
    events,
    input,
    rawErrorMessage: errorMessage,
    sdkTerminalStatus: sdkTerminalStatus ?? "unknown",
  });
}

export function mapMidStreamFailure(
  err: unknown,
  input: AgentRunInput,
  events: readonly ThreadEvent[],
  durationMs: number,
): AgentRunResult {
  const rawErrorMessage = err instanceof Error ? err.message : String(err);
  const failureCategory = classifyFailure({
    durationMs,
    events,
    ...(input.maxRunDurationMs !== undefined && { maxRunDurationMs: input.maxRunDurationMs }),
    rawErrorMessage,
    sdkTerminalStatus: "stream-throw",
    thrownErr: err,
    thrownError: true,
  });
  return failedResult({
    category: failureCategory,
    durationMs,
    events,
    input,
    rawErrorMessage,
    sdkTerminalStatus: "stream-throw",
    thrownErr: err,
  });
}

export function mapStreamEndWithoutTerminal(
  input: AgentRunInput,
  events: readonly ThreadEvent[],
  durationMs: number,
): AgentRunResult {
  const rawErrorMessage = "Codex stream ended without a terminal turn event";
  // A stream that ends with no turn.completed/turn.failed/error is an SDK/transport
  // failure, not a logic failure — classify it as sdk-throw, consistent with how
  // core treats thrown runner errors (Copilot review).
  const failureCategory = classifyFailure({
    durationMs,
    events,
    ...(input.maxRunDurationMs !== undefined && { maxRunDurationMs: input.maxRunDurationMs }),
    rawErrorMessage,
    sdkTerminalStatus: "stream-end",
    thrownError: true,
  });
  return failedResult({
    category: failureCategory,
    durationMs,
    events,
    input,
    rawErrorMessage,
    sdkTerminalStatus: "stream-end",
  });
}

// A run aborted via `handle.cancel()` / `input.signal` resolves as cancelled,
// not failed — the SDK rejects the stream with an abort error, but that is a
// user cancellation, not a run failure (codex review).
export function mapCancelled(durationMs: number): AgentRunResult {
  return { branches: [], durationMs, status: "cancelled" };
}

// Codex-bound failure classification — core imports these so it stays
// projection-free. Policy lives in `@ship/agent-runner`.

import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentEvent, BuildFailureDetailInput, ClassifyFailureInput } from "@ship/agent-runner";
import type { FailureCategory } from "@ship/workflow";

import {
  buildFailureDetail as buildFailureDetailBase,
  classifyFailure as classifyFailureBase,
  formatClassifiedErrorMessage,
} from "@ship/agent-runner";

import { codexEventProjection } from "./codex-event-projection.js";

export { formatClassifiedErrorMessage };

export type CodexClassifyFailureInput = Omit<ClassifyFailureInput<ThreadEvent>, "projection"> & {
  readonly thrownErr?: unknown;
  readonly rawErrorMessage?: string;
};

export type CodexBuildFailureDetailInput = Omit<
  BuildFailureDetailInput<ThreadEvent>,
  "projection"
> & {
  readonly thrownErr?: unknown;
};

// Narrow signal for codex sandbox refusing a command under workspace-write policy.
const SANDBOX_DENIAL_PATTERN =
  /sandbox(?:ed)?\s+(?:policy|violation)|not permitted in (?:the )?sandbox|permission denied.*sandbox/i;

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

function isGatewayUnreachableText(text: string): boolean {
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed/i.test(text)) return true;
  if (/gateway/i.test(text) && /\b[45]\d{2}\b/.test(text)) return true;
  return false;
}

function isGatewayUnreachableError(err: unknown): boolean {
  return isGatewayUnreachableText(errorText(err));
}

function lastFailedSandboxCommand(events: readonly ThreadEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (codexEventProjection.eventKind(ev) !== "tool_call") continue;
    const status = codexEventProjection.toolCallStatus(ev);
    if (status !== "error") continue;
    if (codexEventProjection.toolCallName(ev) !== "command_execution") continue;
    const resultText = codexEventProjection.resultText(ev);
    if (resultText !== undefined && SANDBOX_DENIAL_PATTERN.test(resultText)) return true;
  }
  return false;
}

function lastFailedFileChange(events: readonly ThreadEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (codexEventProjection.eventKind(ev) !== "tool_call") continue;
    const status = codexEventProjection.toolCallStatus(ev);
    if (status !== "error") continue;
    if (codexEventProjection.toolCallName(ev) === "file_change") return true;
  }
  return false;
}

function terminalLooksLikeGatewayFailure(input: CodexClassifyFailureInput): boolean {
  const status = input.sdkTerminalStatus;
  if (status !== "turn.failed" && status !== "error") return false;
  if (input.rawErrorMessage !== undefined && isGatewayUnreachableText(input.rawErrorMessage)) {
    return true;
  }
  for (let i = input.events.length - 1; i >= 0; i--) {
    const ev = input.events[i];
    if (ev === undefined) continue;
    const text = codexEventProjection.resultText(ev);
    if (text !== undefined && text.length > 0 && isGatewayUnreachableText(text)) return true;
  }
  return false;
}

export function classifyFailure(input: CodexClassifyFailureInput): FailureCategory {
  if (input.thrownError === true) {
    if (input.thrownErr !== undefined && isGatewayUnreachableError(input.thrownErr)) {
      return "gateway-unreachable";
    }
    return "sdk-throw";
  }

  if (lastFailedSandboxCommand(input.events)) return "sandbox-denial";
  if (lastFailedFileChange(input.events)) return "patch-apply-fail";

  if (terminalLooksLikeGatewayFailure(input)) return "gateway-unreachable";

  return classifyFailureBase({
    ...input,
    projection: codexEventProjection,
  });
}

export function buildFailureDetail(input: CodexBuildFailureDetailInput): string {
  return buildFailureDetailBase({
    ...input,
    projection: codexEventProjection,
  });
}

export type { AgentEvent };

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
  // Only 5xx (502/503/504) signal an unreachable gateway. 4xx (401/403 auth,
  // 400/404 wrong-endpoint config) are not transport failures and need different
  // operator remediation, so they must not land here (claude review).
  if (/gateway/i.test(text) && /\b5\d{2}\b/.test(text)) return true;
  return false;
}

function isGatewayUnreachableError(err: unknown): boolean {
  return isGatewayUnreachableText(errorText(err));
}

// Classify by the MOST RECENT failed tool event so a stale earlier sandbox
// denial can't mask a later patch-apply failure, or vice versa (Bugbot).
function recentToolFailureCategory(
  events: readonly ThreadEvent[],
): "sandbox-denial" | "patch-apply-fail" | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (codexEventProjection.eventKind(ev) !== "tool_call") continue;
    if (codexEventProjection.toolCallStatus(ev) !== "error") continue;
    const name = codexEventProjection.toolCallName(ev);
    if (name === "file_change") return "patch-apply-fail";
    if (name === "command_execution") {
      const resultText = codexEventProjection.resultText(ev);
      if (resultText !== undefined && SANDBOX_DENIAL_PATTERN.test(resultText)) {
        return "sandbox-denial";
      }
      return undefined; // a non-sandbox command failure is a logic failure (base classifier)
    }
    return undefined; // most-recent failed tool is mcp/other → base classifier
  }
  return undefined;
}

// Gateway-unreachable is a transport failure — keyed ONLY off the terminal
// event's own error message (turn.failed.error.message / top-level error.message),
// never the tool-output event tail. A command that printed "fetch failed" is a
// tool/logic failure, not an unreachable gateway (Bugbot + claude review).
function terminalLooksLikeGatewayFailure(input: CodexClassifyFailureInput): boolean {
  const status = input.sdkTerminalStatus;
  if (status !== "turn.failed" && status !== "error") return false;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const ev = input.events[i];
    if (ev === undefined) continue;
    if (codexEventProjection.terminalStatus(ev) === undefined) continue;
    const message = codexEventProjection.statusMessage(ev);
    return message !== undefined && isGatewayUnreachableText(message);
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

  const toolFailure = recentToolFailureCategory(input.events);
  if (toolFailure !== undefined) return toolFailure;

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

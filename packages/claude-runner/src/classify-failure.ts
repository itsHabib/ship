// Claude-bound failure classification — core imports these so it stays
// projection-free. Policy lives in `@ship/agent-runner`.

import type { AgentEvent, BuildFailureDetailInput, ClassifyFailureInput } from "@ship/agent-runner";
import type { FailureCategory } from "@ship/workflow";

import {
  buildFailureDetail as buildFailureDetailBase,
  classifyFailure as classifyFailureBase,
  formatClassifiedErrorMessage,
} from "@ship/agent-runner";

import { claudeEventProjection } from "./claude-event-projection.js";

export { formatClassifiedErrorMessage };

export type ClaudeClassifyFailureInput = Omit<ClassifyFailureInput, "projection"> & {
  readonly thrownErr?: unknown;
};

export type ClaudeBuildFailureDetailInput = Omit<BuildFailureDetailInput, "projection"> & {
  readonly thrownErr?: unknown;
};

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

function isGatewayUnreachableText(text: string): boolean {
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed/i.test(text)) return true;
  // Only 5xx signal an unreachable gateway. 401/403 are auth rejections, not transport.
  if (/gateway/i.test(text) && /\b5\d{2}\b/.test(text)) return true;
  return false;
}

function isGatewayUnreachableError(err: unknown): boolean {
  return isGatewayUnreachableText(errorText(err));
}

function isGatewayAuthText(text: string): boolean {
  if (/\b401\s+Unauthorized\b/i.test(text)) return true;
  if (/\b403\s+Forbidden\b/i.test(text)) return true;
  if (/\bHTTP\s+401\b/i.test(text)) return true;
  if (/\bHTTP\s+403\b/i.test(text)) return true;
  if (/\bstatus(?:\s+code)?\s*[=:]\s*(401|403)\b/i.test(text)) return true;
  return false;
}

function isGatewayAuthError(err: unknown): boolean {
  return isGatewayAuthText(errorText(err));
}

function subtypeCategory(subtype: string | undefined): FailureCategory | undefined {
  if (subtype === "error_max_budget_usd" || subtype === "error_max_turns") {
    return "budget-exceeded";
  }
  if (subtype === "error_max_structured_output_retries") return "logic";
  return undefined;
}

export function classifyFailure(input: ClaudeClassifyFailureInput): FailureCategory {
  if (input.thrownError === true) {
    if (input.thrownErr !== undefined && isGatewayUnreachableError(input.thrownErr)) {
      return "gateway-unreachable";
    }
    if (input.thrownErr !== undefined && isGatewayAuthError(input.thrownErr)) {
      return "gateway-auth";
    }
    return "sdk-throw";
  }

  const mapped = subtypeCategory(input.sdkTerminalStatus);
  if (mapped === "budget-exceeded" || mapped === "logic") return mapped;

  // Remaining subtypes (incl. `error_during_execution`, whose cause lives in
  // the tool output) are classified from the event tail by the
  // projection-backed base classifier.
  return classifyFailureBase({
    ...input,
    projection: claudeEventProjection,
  });
}

export function buildFailureDetail(input: ClaudeBuildFailureDetailInput): string {
  return buildFailureDetailBase({
    ...input,
    projection: claudeEventProjection,
  });
}

export type { AgentEvent };

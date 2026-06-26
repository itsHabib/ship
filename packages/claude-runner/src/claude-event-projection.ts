/**
 * Claude `SDKMessage` → neutral `EventProjection`. Normalizes Claude message
 * shapes (assistant/user content blocks, result subtypes) to the canonical
 * `ToolCallStatus` vocabulary.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventProjection } from "@ship/agent-runner";

import { stringifyToolCallResult } from "@ship/agent-runner";

interface ContentBlock {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

function asRecord(ev: unknown): Record<string, unknown> {
  return ev as Record<string, unknown>;
}

function messageContent(ev: Record<string, unknown>): ContentBlock[] {
  const message = ev["message"];
  if (message === null || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return [];
  return content as ContentBlock[];
}

function lastToolUseBlock(blocks: readonly ContentBlock[]): ContentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === "tool_use") return block;
  }
  return undefined;
}

function lastToolResultBlock(blocks: readonly ContentBlock[]): ContentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === "tool_result") return block;
  }
  return undefined;
}

function commandFromToolInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const command = (input as Record<string, unknown>)["command"];
  if (typeof command === "string" && command.length > 0) return command;
  return undefined;
}

function parseTimestamp(raw: Record<string, unknown>): number | undefined {
  const ts = raw["timestamp"];
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

function resultErrors(msg: Record<string, unknown>): string[] {
  const errors = msg["errors"];
  if (!Array.isArray(errors)) return [];
  return errors.filter((e): e is string => typeof e === "string");
}

export const claudeEventProjection: EventProjection<SDKMessage> = {
  commandArg(ev) {
    const raw = asRecord(ev);
    if (raw["type"] === "assistant") {
      const toolUse = lastToolUseBlock(messageContent(raw));
      if (toolUse === undefined) return undefined;
      if (toolUse.name !== "Bash") return undefined;
      return commandFromToolInput(toolUse.input);
    }
    return undefined;
  },
  eventKind(ev) {
    const raw = asRecord(ev);
    const kind = raw["type"];
    if (kind === "result") return "status";
    if (kind === "system" && raw["subtype"] === "init") return "status";
    if (kind === "assistant") {
      if (lastToolUseBlock(messageContent(raw)) !== undefined) return "tool_call";
      return "other";
    }
    if (kind === "user") {
      if (lastToolResultBlock(messageContent(raw)) !== undefined) return "tool_call";
      return "other";
    }
    return "other";
  },
  resultText(ev) {
    const raw = asRecord(ev);
    if (raw["type"] === "user") {
      const toolResult = lastToolResultBlock(messageContent(raw));
      if (toolResult === undefined) return "";
      return stringifyToolCallResult(toolResult.content);
    }
    if (raw["type"] === "result") {
      if (raw["subtype"] === "success") {
        const result = raw["result"];
        return typeof result === "string" ? result : "";
      }
      return resultErrors(raw).join("; ");
    }
    return "";
  },
  statusMessage(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "result") return undefined;
    if (raw["subtype"] === "success") return undefined;
    const reason = raw["terminal_reason"];
    if (typeof reason === "string" && reason.length > 0) return reason;
    return undefined;
  },
  terminalStatus(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "result") return undefined;
    const subtype = raw["subtype"];
    return typeof subtype === "string" ? subtype : undefined;
  },
  timestamp(ev) {
    return parseTimestamp(asRecord(ev));
  },
  toolCallId(ev) {
    const raw = asRecord(ev);
    if (raw["type"] === "assistant") {
      const toolUse = lastToolUseBlock(messageContent(raw));
      const id = toolUse?.id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    }
    if (raw["type"] === "user") {
      const toolResult = lastToolResultBlock(messageContent(raw));
      const id = toolResult?.tool_use_id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    }
    return undefined;
  },
  toolCallName(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "assistant") return undefined;
    const toolUse = lastToolUseBlock(messageContent(raw));
    const name = toolUse?.name;
    return typeof name === "string" ? name : undefined;
  },
  toolCallStatus(ev) {
    const raw = asRecord(ev);
    if (raw["type"] === "assistant") {
      if (lastToolUseBlock(messageContent(raw)) !== undefined) return "running";
      return undefined;
    }
    if (raw["type"] === "user") {
      const toolResult = lastToolResultBlock(messageContent(raw));
      if (toolResult === undefined) return undefined;
      if (toolResult.is_error === true) return "error";
      return "completed";
    }
    return undefined;
  },
};

export function eventRecord(ev: SDKMessage): Record<string, unknown> {
  return ev;
}

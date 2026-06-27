/**
 * Codex `ThreadEvent` → neutral `EventProjection`. Normalizes Codex item
 * spellings to the canonical `ToolCallStatus` vocabulary.
 */

import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { EventProjection } from "@ship/agent-runner";

import { stringifyToolCallResult } from "@ship/agent-runner";

const TOOL_ITEM_TYPES = new Set(["command_execution", "file_change", "mcp_tool_call"]);

function asRecord(ev: unknown): Record<string, unknown> {
  return ev as Record<string, unknown>;
}

function itemFromEvent(ev: Record<string, unknown>): ThreadItem | undefined {
  const item = ev["item"];
  if (item === null || typeof item !== "object") return undefined;
  return item as ThreadItem;
}

function isToolItem(item: ThreadItem): boolean {
  return TOOL_ITEM_TYPES.has(item.type);
}

function normalizeItemStatus(
  status: string | undefined,
): "running" | "completed" | "error" | undefined {
  if (status === "in_progress") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "error";
  return undefined;
}

function itemStatus(item: ThreadItem): string | undefined {
  if (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call"
  ) {
    return item.status;
  }
  return undefined;
}

function itemResultText(item: ThreadItem): string {
  if (item.type === "command_execution") return item.aggregated_output;
  if (item.type === "mcp_tool_call") {
    if (item.error?.message !== undefined && item.error.message.length > 0)
      return item.error.message;
    // Guarded stringify — a raw JSON.stringify throws on circular structures or
    // BigInt, which would break event projection + downstream mapping (Copilot review).
    if (item.result !== undefined) return stringifyToolCallResult(item.result);
    return "";
  }
  if (item.type === "agent_message") return item.text;
  if (item.type === "error") return item.message;
  return "";
}

function turnFailedMessage(ev: Record<string, unknown>): string | undefined {
  if (ev["type"] !== "turn.failed") return undefined;
  const error = ev["error"];
  if (error === null || typeof error !== "object") return undefined;
  const message = (error as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : undefined;
}

export const codexEventProjection: EventProjection<ThreadEvent> = {
  commandArg(ev) {
    const raw = asRecord(ev);
    const item = itemFromEvent(raw);
    if (item?.type !== "command_execution") return undefined;
    if (item.command.length === 0) return undefined;
    return item.command;
  },
  eventKind(ev) {
    const raw = asRecord(ev);
    const type = raw["type"];
    if (type === "turn.started" || type === "turn.completed" || type === "turn.failed") {
      return "status";
    }
    if (type === "error") return "status";
    const item = itemFromEvent(raw);
    if (item !== undefined && isToolItem(item)) return "tool_call";
    return "other";
  },
  resultText(ev) {
    const raw = asRecord(ev);
    const type = raw["type"];
    if (type === "turn.failed") {
      const message = turnFailedMessage(raw);
      return message !== undefined && message.length > 0 ? message : undefined;
    }
    if (type === "error") {
      const message = raw["message"];
      return typeof message === "string" && message.length > 0 ? message : undefined;
    }
    const item = itemFromEvent(raw);
    if (item === undefined) return undefined;
    const text = itemResultText(item);
    return text.length > 0 ? text : undefined;
  },
  statusMessage(ev) {
    const raw = asRecord(ev);
    if (raw["type"] === "turn.failed") return turnFailedMessage(raw);
    if (raw["type"] === "error") {
      const message = raw["message"];
      return typeof message === "string" && message.length > 0 ? message : undefined;
    }
    return undefined;
  },
  terminalStatus(ev) {
    const raw = asRecord(ev);
    const type = raw["type"];
    if (type === "turn.completed" || type === "turn.failed" || type === "error") return type;
    return undefined;
  },
  timestamp(_ev) {
    return undefined;
  },
  toolCallId(ev) {
    const item = itemFromEvent(asRecord(ev));
    if (item === undefined || !isToolItem(item)) return undefined;
    return item.id.length > 0 ? item.id : undefined;
  },
  toolCallName(ev) {
    const item = itemFromEvent(asRecord(ev));
    if (item === undefined || !isToolItem(item)) return undefined;
    if (item.type === "mcp_tool_call") return item.tool;
    return item.type;
  },
  toolCallStatus(ev) {
    const item = itemFromEvent(asRecord(ev));
    if (item === undefined || !isToolItem(item)) return undefined;
    return normalizeItemStatus(itemStatus(item));
  },
};

export function eventRecord(ev: ThreadEvent): Record<string, unknown> {
  return ev;
}

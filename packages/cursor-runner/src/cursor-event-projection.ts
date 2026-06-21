/**
 * Cursor `SDKMessage` → neutral `EventProjection`. Normalizes cursor's raw
 * spellings (uppercase status events, mixed-case tool statuses) to the
 * canonical `ToolCallStatus` vocabulary.
 */

import type { SDKMessage } from "@cursor/sdk";
import type { EventProjection, ToolCallStatus } from "@ship/agent-runner";

import { stringifyToolCallResult } from "@ship/agent-runner";

function asRecord(ev: unknown): Record<string, unknown> {
  return ev as Record<string, unknown>;
}

function parseEventTimestamp(raw: Record<string, unknown>): number | undefined {
  const ts = raw["ts"] ?? raw["startedAt"];
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeToolCallStatus(raw: unknown): ToolCallStatus | undefined {
  if (raw === "running" || raw === "completed") return raw;
  if (raw === "error" || raw === "failed") return raw;
  return undefined;
}

function commandLikeFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const command = record["command"];
  if (typeof command === "string" && command.length > 0) return command;
  return undefined;
}

export const cursorEventProjection: EventProjection<SDKMessage> = {
  commandArg(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "tool_call") return undefined;
    return commandLikeFromArgs(raw["args"]);
  },
  eventKind(ev) {
    const kind = asRecord(ev)["type"];
    return typeof kind === "string" ? kind : undefined;
  },
  resultText(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "tool_call") return "";
    return stringifyToolCallResult(raw["result"]);
  },
  statusMessage(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "status") return undefined;
    const status = raw["status"];
    if (status !== "ERROR" && status !== "EXPIRED" && status !== "CANCELLED") return undefined;
    const message = raw["message"];
    return typeof message === "string" && message.length > 0 ? message : undefined;
  },
  terminalStatus(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "status") return undefined;
    const status = raw["status"];
    return typeof status === "string" ? status : undefined;
  },
  timestamp(ev) {
    return parseEventTimestamp(asRecord(ev));
  },
  toolCallId(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "tool_call") return undefined;
    const id = raw["call_id"];
    return typeof id === "string" && id.length > 0 ? id : undefined;
  },
  toolCallName(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "tool_call") return undefined;
    const name = raw["name"];
    return typeof name === "string" ? name : undefined;
  },
  toolCallStatus(ev) {
    const raw = asRecord(ev);
    if (raw["type"] !== "tool_call") return undefined;
    return normalizeToolCallStatus(raw["status"]);
  },
};

export function eventRecord(ev: SDKMessage): Record<string, unknown> {
  return ev as unknown as Record<string, unknown>;
}

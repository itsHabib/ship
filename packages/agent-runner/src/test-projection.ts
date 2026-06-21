/**
 * Minimal projection for agent-runner unit tests (not cursor-specific).
 */
import type { EventProjection } from "./event-projection.js";

export const testEventProjection: EventProjection<Record<string, unknown>> = {
  commandArg(ev) {
    if (ev["type"] !== "tool_call") return undefined;
    const args = ev["args"];
    if (args !== null && typeof args === "object") {
      const command = (args as Record<string, unknown>)["command"];
      return typeof command === "string" ? command : undefined;
    }
    return undefined;
  },
  eventKind(ev) {
    const kind = ev["type"];
    return typeof kind === "string" ? kind : undefined;
  },
  resultText(ev) {
    if (ev["type"] !== "tool_call") return "";
    const result = ev["result"];
    return typeof result === "string" ? result : "";
  },
  statusMessage(ev) {
    if (ev["type"] !== "status") return undefined;
    const message = ev["message"];
    return typeof message === "string" ? message : undefined;
  },
  terminalStatus(ev) {
    if (ev["type"] !== "status") return undefined;
    const status = ev["status"];
    return typeof status === "string" ? status : undefined;
  },
  timestamp(ev) {
    const ts = ev["ts"];
    if (typeof ts !== "string") return undefined;
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : undefined;
  },
  toolCallId(ev) {
    if (ev["type"] !== "tool_call") return undefined;
    const id = ev["call_id"];
    return typeof id === "string" ? id : undefined;
  },
  toolCallName(ev) {
    if (ev["type"] !== "tool_call") return undefined;
    const name = ev["name"];
    return typeof name === "string" ? name : undefined;
  },
  toolCallStatus(ev) {
    if (ev["type"] !== "tool_call") return undefined;
    const status = ev["status"];
    if (
      status === "running" ||
      status === "completed" ||
      status === "error" ||
      status === "failed"
    ) {
      return status;
    }
    return undefined;
  },
};

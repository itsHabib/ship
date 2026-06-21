/** Projection-driven helpers for event streams. */

import type { EventProjection } from "./event-projection.js";

import { summarizeToolCall } from "./formatters.js";

export function lastEventTimestamp<E>(
  projection: EventProjection<E>,
  events: readonly E[],
): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const ts = projection.timestamp(ev);
    if (ts !== undefined) return ts;
  }
  return undefined;
}

function finalStatusByCallId<E>(
  projection: EventProjection<E>,
  events: readonly E[],
): Map<string, string> {
  const byId = new Map<string, string>();
  for (const ev of events) {
    if (projection.eventKind(ev) !== "tool_call") continue;
    const id = projection.toolCallId(ev);
    const status = projection.toolCallStatus(ev);
    if (id !== undefined && status !== undefined) byId.set(id, status);
  }
  return byId;
}

export interface RunningToolCallView {
  readonly name: string | undefined;
  readonly command: string | undefined;
  readonly timestamp: number | undefined;
}

/** Most recent tool_call still running at stream end. */
export function lastRunningToolCall<E>(
  projection: EventProjection<E>,
  events: readonly E[],
): RunningToolCallView | undefined {
  const finalStatus = finalStatusByCallId(projection, events);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (projection.eventKind(ev) !== "tool_call") continue;
    const id = projection.toolCallId(ev);
    const rawStatus = projection.toolCallStatus(ev);
    const effectiveStatus = id !== undefined ? finalStatus.get(id) : rawStatus;
    if (effectiveStatus === "running") {
      return {
        command: projection.commandArg(ev),
        name: projection.toolCallName(ev),
        timestamp: projection.timestamp(ev),
      };
    }
  }
  return undefined;
}

export function runningToolAgeMs<E>(
  projection: EventProjection<E>,
  toolCall: RunningToolCallView,
  events: readonly E[],
  durationMs: number | undefined,
  minAgeMs: number,
): number | undefined {
  const toolTs = toolCall.timestamp;
  const endTs = lastEventTimestamp(projection, events);
  if (toolTs !== undefined && endTs !== undefined) {
    const age = endTs - toolTs;
    return age >= 0 ? age : undefined;
  }
  if (durationMs !== undefined && durationMs >= minAgeMs) return durationMs;
  return undefined;
}

export function runningToolDetail(
  toolCall: RunningToolCallView,
  ageMs: number,
  formatAge: (ms: number) => string,
): string {
  const summary = summarizeToolCall(toolCall.name, toolCall.command);
  return `last activity: ${summary} running ${formatAge(ageMs)}, never completed`;
}

export function lastTerminalStatus<E>(
  projection: EventProjection<E>,
  events: readonly E[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const status = projection.terminalStatus(ev);
    if (status !== undefined) return status;
  }
  return undefined;
}

export function lastFailedToolCallDetail<E>(
  projection: EventProjection<E>,
  events: readonly E[],
): string | undefined {
  let detail: string | undefined;
  for (const ev of events) {
    if (projection.eventKind(ev) !== "tool_call") continue;
    const status = projection.toolCallStatus(ev);
    if (status !== "error" && status !== "failed") continue;
    const resultText = projection.resultText(ev);
    if (resultText !== undefined && resultText.length > 0) {
      detail = resultText;
      continue;
    }
    const name = projection.toolCallName(ev) ?? "tool";
    detail = `${name} errored`;
  }
  return detail;
}

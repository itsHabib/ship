/** Duration and event-window formatters shared by classifiers and runners. */

export function formatWallDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 60) return `${String(totalMin)}m`;
  const hours = Math.floor(totalMin / 60);
  const rem = totalMin % 60;
  return rem > 0 ? `${String(hours)}h${String(rem)}m` : `${String(hours)}h`;
}

/** Second-granularity formatter for in-flight tool_call age in error/detail text. */
export function formatRunningToolAge(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${String(sec)}s`;
  if (sec === 0) return `${String(min)}m`;
  return `${String(min)}m${String(sec)}s`;
}

/** Upper bound on streamed events retained for failure classification. */
export const MAX_CLASSIFICATION_EVENTS = 256;

const TOOL_COMMAND_SUMMARY_MAX = 80;

function truncateCommandSummary(command: string): string {
  if (command.length <= TOOL_COMMAND_SUMMARY_MAX) return command;
  const keep = TOOL_COMMAND_SUMMARY_MAX - 3;
  return `${command.slice(0, keep)}...`;
}

export function summarizeToolCall(name: string | undefined, command: string | undefined): string {
  const toolName = name ?? "tool";
  if (command === undefined) return toolName;
  return `${toolName} '${truncateCommandSummary(command)}'`;
}

export function stringifyToolCallResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
    return String(result);
  }
  if (result === undefined || result === null) return "";
  if (typeof result === "function" || typeof result === "symbol") return "tool_call error";
  try {
    return JSON.stringify(result);
  } catch {
    return "tool_call error";
  }
}

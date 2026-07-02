/**
 * Write-path enrichment for events persisted to `events.ndjson`.
 *
 * Raw SDK events are stored verbatim except for additive fields stamped
 * at the single `onEvent` choke point: per-event `ts` and structured
 * shell exit markers when the payload exposes them.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnTimestamp(record: Record<string, unknown>): boolean {
  return record["ts"] !== undefined || record["startedAt"] !== undefined;
}

function structuredShellExitCode(result: unknown): number | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const exitCode = result["exitCode"] ?? result["exit_code"];
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) {
    return undefined;
  }
  return exitCode;
}

function shellOutcomeFields(event: Record<string, unknown>): Record<string, unknown> {
  if (event["type"] !== "tool_call" || event["name"] !== "shell") {
    return {};
  }
  const exitCode = structuredShellExitCode(event["result"]);
  if (exitCode === undefined) {
    return {};
  }
  return { exit_code: exitCode };
}

/** Stamp additive persist fields onto an event before NDJSON write. */
export function prepareEventForPersist(event: unknown): unknown {
  if (!isRecord(event)) {
    return event;
  }

  const enriched: Record<string, unknown> = { ...event, ...shellOutcomeFields(event) };
  if (hasOwnTimestamp(event)) {
    return enriched;
  }

  return { ...enriched, ts: new Date().toISOString() };
}

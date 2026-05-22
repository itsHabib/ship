/**
 * Shared `RunResult` → `CursorRunResult` mapping used by local and cloud
 * runners (phase 04 — ED-1).
 */

import type { RunResult } from "@cursor/sdk";

import type { CursorRunInput, CursorRunResult } from "./runner.js";

import { cloudDebugLog } from "./debug.js";
/** Maps `RunResult` (SDK vocab) to `CursorRunResult` (Ship vocab) per ED-3. */
export function mapRunResult(result: RunResult, input: CursorRunInput): CursorRunResult {
  if (result.status === "finished") return mapTerminalResult(result, "succeeded");
  if (result.status === "cancelled") return mapTerminalResult(result, "cancelled");
  return mapErrorResult(result, input);
}

// Shared shape for finished / cancelled — same field set, different status tag.
export function mapTerminalResult(
  result: RunResult,
  status: "succeeded" | "cancelled",
): CursorRunResult {
  cloudDebugLog("mapTerminalResult result.git", result.git);
  return {
    branches: result.git?.branches ?? [],
    durationMs: result.durationMs ?? 0,
    ...(result.model !== undefined && { model: result.model }),
    status,
    ...(result.result !== undefined && { summary: result.result }),
  };
}

// Failed runs carry an errorMessage; the SDK's `result` is the agent's
// last text, used as the message when present.
export function mapErrorResult(result: RunResult, input: CursorRunInput): CursorRunResult {
  return {
    branches: result.git?.branches ?? [],
    durationMs: result.durationMs ?? 0,
    model: result.model ?? input.model,
    errorMessage: result.result ?? "Cursor SDK reported error without a message",
    status: "failed",
  };
}

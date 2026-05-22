/**
 * Shared `RunResult` → `CursorRunResult` mapping used by local and cloud
 * runners (phase 04 — ED-1).
 */

import type { RunResult } from "@cursor/sdk";

import type { CloudRunSpec, CursorRunInput, CursorRunResult } from "./runner.js";

/** Maps `RunResult` (SDK vocab) to `CursorRunResult` (Ship vocab) per ED-3. */
export function mapRunResult(
  result: RunResult,
  input: CursorRunInput,
  requestedCloudSpec?: CloudRunSpec,
): CursorRunResult {
  const spec = requestedCloudSpec ?? input.cloud;
  if (result.status === "finished") return mapTerminalResult(result, "succeeded", spec);
  if (result.status === "cancelled") return mapTerminalResult(result, "cancelled", spec);
  return mapErrorResult(result, input);
}

type FirstBranch = NonNullable<NonNullable<RunResult["git"]>["branches"]>[number];

function autoCreatePrWarning(
  spec: CloudRunSpec,
  branch: FirstBranch | undefined,
): string | undefined {
  if (spec.autoCreatePR !== true) return undefined;
  const prUrl = branch === undefined ? undefined : branch.prUrl;
  if (prUrl !== undefined && prUrl !== "") return undefined;
  return "autoCreatePR was requested but result.branches[0].prUrl is undefined";
}

function branchExpectedWarning(
  spec: CloudRunSpec,
  branch: FirstBranch | undefined,
): string | undefined {
  if (spec.workOnCurrentBranch === true) return undefined;
  const branchName = branch === undefined ? undefined : branch.branch;
  if (branchName !== undefined && branchName !== "") return undefined;
  return "a new branch was expected (workOnCurrentBranch !== true) but result.branches[0].branch is undefined";
}

function startingRefMismatchWarning(spec: CloudRunSpec, result: RunResult): string | undefined {
  const requested = spec.repos[0].startingRef;
  if (requested === undefined || requested === "") return undefined;
  // Cloud RunResult may surface `git.ref`; SDK typings only declare `branches` today.
  const reported = (result.git as { readonly ref?: string } | undefined)?.ref;
  if (reported === undefined || reported === "" || requested === reported) return undefined;
  return `startingRef '${requested}' was requested but result.git reports ref '${reported}'`;
}

export function deriveCloudWarnings(spec: CloudRunSpec | undefined, result: RunResult): string[] {
  if (spec === undefined) return [];
  const branch = result.git?.branches[0];
  const candidates = [
    autoCreatePrWarning(spec, branch),
    branchExpectedWarning(spec, branch),
    startingRefMismatchWarning(spec, result),
  ];
  return candidates.filter((w): w is string => w !== undefined);
}

// Shared shape for finished / cancelled — same field set, different status tag.
// Cloud-runner wraps this and emits the debug log itself; local-runner doesn't.
// Keeping the debug call out of here preserves the SHIP_CLOUD_DEBUG-only intent.
export function mapTerminalResult(
  result: RunResult,
  status: "succeeded" | "cancelled",
  requestedCloudSpec?: CloudRunSpec,
): CursorRunResult {
  const warnings = deriveCloudWarnings(requestedCloudSpec, result);
  return {
    branches: result.git?.branches ?? [],
    ...(warnings.length > 0 && { warnings }),
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

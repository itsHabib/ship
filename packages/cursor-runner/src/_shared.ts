/**
 * Shared `RunResult` → `CursorRunResult` mapping used by local and cloud
 * runners (phase 04 — ED-1).
 */

import type { RunResult } from "@cursor/sdk";

import type {
  CloudRunSpec,
  CursorRunAttachInput,
  CursorRunInput,
  CursorRunResult,
} from "./runner.js";

/**
 * Project a `CursorRunAttachInput` onto the `CursorRunInput` shape so the
 * shared post-`agent.send` pipeline (`#buildHandle` in the runners) can be
 * reused on the attach path. `prompt` and `cwd` are empty because the
 * pipeline doesn't re-issue a prompt — the agent is already running. The
 * `runtime` discriminator is set by the caller: `CloudCursorRunner` passes
 * `"cloud"` so downstream warnings can derive cloud-divergence; the fake
 * leaves it undefined (matching the runner's run-path treatment of
 * `CursorRunInput.runtime` as optional with local default).
 */
export function attachInputAsRunInput(
  input: CursorRunAttachInput,
  runtime?: "local" | "cloud",
): CursorRunInput {
  return {
    cwd: "",
    model: input.model,
    onEvent: input.onEvent,
    prompt: "",
    ...(runtime !== undefined && { runtime }),
    ...(input.cloud !== undefined && { cloud: input.cloud }),
    ...(input.agents !== undefined && { agents: input.agents }),
    ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
    ...(input.signal !== undefined && { signal: input.signal }),
  };
}

// Cloud spec is forwarded by the cloud runner only — local-runner deliberately
// omits it so a `CursorRunInput.cloud` carried by a local-runtime caller never
// triggers cloud-divergence warnings on the persisted result.
export function mapRunResult(
  result: RunResult,
  input: CursorRunInput,
  requestedCloudSpec?: CloudRunSpec,
): CursorRunResult {
  if (result.status === "finished")
    return mapTerminalResult(result, "succeeded", requestedCloudSpec);
  if (result.status === "cancelled")
    return mapTerminalResult(result, "cancelled", requestedCloudSpec);
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
  // Cancelled runs are noisy by construction — no branch / no PR is expected,
  // so the divergence warnings would be uniformly false-positive. Only derive
  // warnings on succeeded terminal state.
  const warnings = status === "succeeded" ? deriveCloudWarnings(requestedCloudSpec, result) : [];
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

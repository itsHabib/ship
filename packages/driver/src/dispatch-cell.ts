/**
 * Dispatch-cell policy: the wired `(runtime, provider)` matrix and the
 * structural + credential preconditions a target must satisfy before it can be
 * dispatched.
 *
 * One source of truth for three callers that used to each know a slice of it:
 * model-pool assignment (`assign.ts`, model-lottery §4.3), fallback-chain import
 * validation (dispatch-fallback §4.4), and the engine preflight. Keeping the
 * matrix + requirements here is what lets the fallback chain *derive* the rules
 * rather than restate them (spec §6).
 */

import type { AgentProvider } from "@ship/workflow";

import type { ManifestStream } from "./manifest.js";

export type Runtime = NonNullable<ManifestStream["runtime"]>;

// Legal (provider, runtime) cells — the shape of `selectRunner`'s matrix
// (packages/core/src/service.ts). A cell absent here is an authoring error
// (e.g. claude/rooms, codex/cloud); whether a legal cell has a runner wired is a
// dispatch-time concern, not a validation-time one.
const LEGAL_RUNTIMES_BY_PROVIDER: Record<AgentProvider, readonly Runtime[]> = {
  cursor: ["local", "cloud", "rooms"],
  claude: ["local", "cloud"],
  codex: ["local"],
};

/** True when `(provider, runtime)` is a legal cell of the dispatch matrix. */
export function isLegalCell(provider: AgentProvider, runtime: Runtime): boolean {
  return LEGAL_RUNTIMES_BY_PROVIDER[provider].includes(runtime);
}

/** A structural precondition a dispatch cell fails to meet. */
export type CellStructuralIssue = "unwired-cell" | "needs-branch" | "needs-repo-url";

/** Context a cell's structural requirements are checked against. */
export interface CellContext {
  branchName: string | undefined;
  repoUrl: string | undefined;
}

/**
 * The first structural requirement `target` fails, or undefined when it is
 * dispatchable. Mirrors import (claude/cloud needs `branch_name`) and the engine
 * preflight (any local needs `branch_name`; any cloud needs `repo_url`). Callers
 * format their own copy from the returned code.
 */
export function cellStructuralIssue(
  target: { runtime: Runtime; provider: AgentProvider },
  ctx: CellContext,
): CellStructuralIssue | undefined {
  if (!isLegalCell(target.provider, target.runtime)) return "unwired-cell";
  if (cellNeedsBranch(target) && ctx.branchName === undefined) return "needs-branch";
  if (target.runtime === "cloud" && ctx.repoUrl === undefined) return "needs-repo-url";
  return undefined;
}

function cellNeedsBranch(target: { runtime: Runtime; provider: AgentProvider }): boolean {
  return target.runtime === "local" || (target.provider === "claude" && target.runtime === "cloud");
}

/**
 * The credential a cell needs, if absent from `env` — the per-cell table of
 * dispatch-fallback §4.4, kept in lockstep with `checkTargetViability`
 * (viability.ts). This is the sync presence check import uses for an advisory
 * warning; the hop-time viability check (with its cursor-catalog fetch) is the
 * authoritative one. Returns the missing-var description, or undefined when the
 * credential is present.
 */
export function missingCredentialEnv(
  target: { runtime: Runtime; provider: AgentProvider },
  env: Record<string, string | undefined>,
): string | undefined {
  if (target.provider === "cursor") {
    return hasEnv(env["CURSOR_API_KEY"]) ? undefined : "CURSOR_API_KEY";
  }
  if (target.provider === "codex") {
    return hasEnv(env["CODEX_API_KEY"]) || hasEnv(env["OPENAI_API_KEY"])
      ? undefined
      : "CODEX_API_KEY or OPENAI_API_KEY";
  }
  return missingClaudeEnv(target.runtime, env);
}

function missingClaudeEnv(
  runtime: Runtime,
  env: Record<string, string | undefined>,
): string | undefined {
  if (runtime === "cloud") {
    return hasEnv(env["ANTHROPIC_API_KEY"]) ? undefined : "ANTHROPIC_API_KEY";
  }
  const present = hasEnv(env["ANTHROPIC_AUTH_TOKEN"]) || hasEnv(env["ANTHROPIC_API_KEY"]);
  return present ? undefined : "ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY";
}

function hasEnv(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

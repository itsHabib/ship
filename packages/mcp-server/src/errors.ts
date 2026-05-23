/**
 * Maps service-level + boundary-validation errors to JSON-RPC `McpError`
 * instances per ED-4 in the Phase 8 task doc. The four tool handlers
 * and the runs resource go through this mapper so the user-vs-internal
 * split is consistent across the entire MCP surface — same shape as
 * the CLI's `isUserError` / `mapErrorToExitCode` pair.
 *
 * `-32602` ("invalid params") covers caller-input rejections and
 * resource-not-found; everything else falls through to `-32603`
 * ("internal error").
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  BaseBranchUnresolvedError,
  BranchPushFailedError,
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  EmptyBranchError,
  GhAuthError,
  GhCreatePrFailedError,
  ImplementPhaseNotSucceededError,
  MissingRepoError,
  OriginHeadUnsetError,
  OriginRepoUnresolvedError,
  WorkdirNotFoundError,
  WorkdirNotGitError,
  WorkflowRunStillActiveError,
} from "@ship/core";
import { WorkflowRunNotFoundError } from "@ship/store";

// Caller-actionable typed errors: pre-row validation from `@ship/core`,
// store resource-not-found, and open_pr environment / integration
// errors. Single source of truth for the user-vs-internal split —
// mirrors the CLI's `USER_ERROR_CLASSES` so the two consumers stay
// aligned without duplicate per-class `if` branches.
const USER_ERROR_CLASSES: readonly (new (...args: never[]) => Error)[] = [
  // ship pre-conditions.
  WorkdirNotFoundError,
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  MissingRepoError,
  WorkflowRunNotFoundError,
  // open_pr pre-conditions.
  ImplementPhaseNotSucceededError,
  WorkdirNotGitError,
  EmptyBranchError,
  BaseBranchUnresolvedError,
  OriginHeadUnsetError,
  OriginRepoUnresolvedError,
  WorkflowRunStillActiveError,
  // open_pr integration failures (git + GitHub).
  GhAuthError,
  BranchPushFailedError,
  GhCreatePrFailedError,
];

/**
 * True when the error is caller-induced (bad payload, missing
 * resource, out-of-range value). Mirrors the CLI's `isUserError`
 * predicate so the two consumers split user-vs-internal the same way.
 */
export function isUserError(err: unknown): boolean {
  if (USER_ERROR_CLASSES.some((c) => err instanceof c)) return true;
  // Built-in "value out of range" — e.g. listRuns limit cap exceeded.
  if (err instanceof RangeError) return true;
  // Boundary schema rejections from Zod (the SDK runs `inputSchema`
  // before the handler, but defensive output `.parse()` calls in our
  // handlers can also throw — both should map to invalid-params).
  return err instanceof Error && err.name === "ZodError";
}

/**
 * Maps a thrown error to an `McpError` with the JSON-RPC error code
 * the SDK will serialize back to the client. Pass-through for an
 * already-`McpError` instance so callers can throw a specific code
 * (e.g. resource-not-found) without re-wrapping.
 */
export function mapErrorToMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = isUserError(err) ? ErrorCode.InvalidParams : ErrorCode.InternalError;
  return new McpError(code, message);
}

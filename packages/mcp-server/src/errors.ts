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
import { DocNotFoundError, DocPathEscapesWorkdirError, WorkdirNotFoundError } from "@ship/core";
import { WorkflowRunNotFoundError } from "@ship/store";

/**
 * True when the error is caller-induced (bad payload, missing
 * resource, out-of-range value). Mirrors the CLI's `isUserError`
 * predicate so the two consumers split user-vs-internal the same way.
 */
export function isUserError(err: unknown): boolean {
  // Pre-row validation throws from `@ship/core`.
  if (err instanceof WorkdirNotFoundError) return true;
  if (err instanceof DocNotFoundError) return true;
  if (err instanceof DocPathEscapesWorkdirError) return true;
  // Resource-not-found surfaced by `@ship/store`.
  if (err instanceof WorkflowRunNotFoundError) return true;
  // Built-in "value out of range" — e.g. listRuns limit cap exceeded.
  if (err instanceof RangeError) return true;
  // Boundary schema rejections from Zod (the SDK runs `inputSchema`
  // before the handler, but defensive output `.parse()` calls in our
  // handlers can also throw — both should map to invalid-params).
  if (err instanceof Error && err.name === "ZodError") return true;
  return false;
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

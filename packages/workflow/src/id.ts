/**
 * ID factories for V1 entities. Each ID is `<prefix>_<ulid>`: `wf_` workflow
 * run, `ph_` phase, `cr_` cursor run. ID-format validation lives at the MCP
 * boundary in `mcp.ts`, not here.
 */

import { ulid } from "ulid";

/** Returns a new workflow-run ID, e.g. `wf_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newWorkflowRunId(): string {
  return `wf_${ulid()}`;
}

/** Returns a new phase ID, e.g. `ph_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newPhaseId(): string {
  return `ph_${ulid()}`;
}

/**
 * Returns a new cursor-run ID, e.g. `cr_01ARZ3NDEKTSV4RRFFQ69G5FAV`. Whether
 * this is the row PK or lives alongside the SDK's `Run.id` is settled in
 * Phase 5 (cursor-runner).
 */
export function newCursorRunId(): string {
  return `cr_${ulid()}`;
}

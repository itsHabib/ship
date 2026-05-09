/**
 * ID factories for the V1 domain entities.
 *
 * Every Ship-owned entity gets a string ID of the form `<prefix>_<ulid>`.
 * The prefix tells you at a glance what kind of entity an opaque ID belongs to
 * (useful in logs, NDJSON archives, error messages, store rows). The ULID body
 * is sortable by creation time, URL-safe, and 26 Crockford-base32 chars.
 *
 * V1 prefixes:
 * - `wf_` — workflow run (the top-level Ship entity)
 * - `ph_` — phase (a unit of work inside a workflow run; V1 has only "implement")
 * - `cr_` — cursor run (one `Agent.send()` call against `@cursor/sdk`)
 *
 * No matching `validateXxxId` helpers ship in V1: the store package reads
 * strings out of TEXT columns and trusts them, and `core` only ever sees IDs
 * it generated itself. The MCP tool surface is the one validation seam where
 * an incoming ID's format matters; that validation lives inline in `mcp.ts`
 * via `z.string().regex(...)`, closer to the boundary it guards.
 */

import { ulid } from "ulid";

/**
 * Returns a new workflow-run ID, e.g. `wf_01ARZ3NDEKTSV4RRFFQ69G5FAV`.
 *
 * Created once per `ship` invocation. Stable for the lifetime of the run;
 * referenced by every artifact path under `runs/<workflowRunId>/`, every
 * phase row in the `phases` table, and every `cursor_runs` row.
 */
export function newWorkflowRunId(): string {
  return `wf_${ulid()}`;
}

/**
 * Returns a new phase ID, e.g. `ph_01ARZ3NDEKTSV4RRFFQ69G5FAV`.
 *
 * Created once per phase started inside a workflow run. V1 always has 0 or 1
 * phases (the "implement" phase). V2 phases (review, ci-fix, etc.) will
 * generate their own phase IDs when they start.
 */
export function newPhaseId(): string {
  return `ph_${ulid()}`;
}

/**
 * Returns a new cursor-run ID, e.g. `cr_01ARZ3NDEKTSV4RRFFQ69G5FAV`.
 *
 * Identifies a single `agent.send()` invocation against `@cursor/sdk`. How
 * this relates to the SDK's own run ID (`Run.id`) is settled in Phase 5
 * (`packages/cursor-runner`) — `domain` only ships the factory; the
 * runner / store decide whether to treat Ship's `cr_<ulid>` as the row PK
 * with the SDK's run ID stored alongside, or to use the SDK run ID directly.
 * spec.md § "SQL schema" + § "CursorRunRef" are not aligned today, so this
 * is intentionally left for the runner phase to resolve.
 */
export function newCursorRunId(): string {
  return `cr_${ulid()}`;
}

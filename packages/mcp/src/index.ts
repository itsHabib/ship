/**
 * `@ship/mcp` — public barrel export.
 *
 * The MCP wire-contract package: input and output schemas for each of the
 * four V1 MCP tools (`ship`, `get_workflow_run`, `list_workflow_runs`,
 * `cancel_workflow_run`), plus the supporting `shipArtifactsSchema`.
 *
 * Why this is its own package instead of folded into `@ship/workflow`:
 * the actual workflow types are consumed by every Ship package (`store`,
 * `tower-adapter`, `cursor-runner`, `core`, `cli`, `mcp-server`) — they're
 * the internal data model. The MCP wire shapes, on the other hand, are
 * only consumed by `core` (which produces `ShipOutput`) and `mcp-server`
 * (which validates incoming tool calls). Splitting keeps the dep surface
 * tight and makes it impossible for, e.g., `store` to accidentally start
 * producing wire-shaped data internally.
 *
 * Depends on `@ship/workflow` for the entity types it embeds in tool
 * outputs (`WorkflowRun`, `WorktreeRef`, `CursorRunRef`, etc.). With
 * `verbatimModuleSyntax: true`, type-only re-exports must use
 * `export type`.
 *
 * Stability promise (within V1): any schema change is a breaking change.
 * `.strict()` is universal here too; unknown keys at the MCP boundary fail
 * loud.
 */

// --- mcp.ts: MCP tool I/O schemas ---
export {
  cancelWorkflowRunInputSchema,
  cancelWorkflowRunOutputSchema,
  getWorkflowRunInputSchema,
  getWorkflowRunOutputSchema,
  listWorkflowRunsInputSchema,
  listWorkflowRunsOutputSchema,
  shipArtifactsSchema,
  shipInputSchema,
  shipOutputSchema,
} from "./mcp.js";

// --- mcp.ts: inferred types ---
export type {
  CancelWorkflowRunInput,
  CancelWorkflowRunOutput,
  GetWorkflowRunInput,
  GetWorkflowRunOutput,
  ListWorkflowRunsInput,
  ListWorkflowRunsOutput,
  ShipArtifacts,
  ShipInput,
  ShipOutput,
} from "./mcp.js";

/**
 * Public barrel for `@ship/mcp` — input/output schemas for the four V1 MCP
 * tools (`ship`, `get_workflow_run`, `list_workflow_runs`,
 * `cancel_workflow_run`) plus `shipArtifactsSchema`.
 */

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

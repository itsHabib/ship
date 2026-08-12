/**
 * `cancel_workflow_run` MCP tool — cancel an in-flight run, idempotent
 * for already-terminal runs. Maps to `ShipService.cancelRun(id)`.
 * Unknown id surfaces as `WorkflowRunNotFoundError` from the store,
 * which `mapErrorToMcpError` routes to `-32602` "invalid params".
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipServiceFactory } from "@ship/core";

import { cancelWorkflowRunInputSchema, cancelWorkflowRunOutputSchema } from "@ship/mcp";

import type { ActiveWorkTracker } from "../active-work.js";

import { mapErrorToMcpError } from "../errors.js";

/** Registers the `cancel_workflow_run` tool on the given `McpServer`. */
export function registerCancelWorkflowRunTool(
  server: McpServer,
  factory: ShipServiceFactory,
  activeWork?: ActiveWorkTracker,
): void {
  server.registerTool(
    "cancel_workflow_run",
    {
      description: "Cancel an in-flight workflow run; idempotent for terminal runs.",
      inputSchema: cancelWorkflowRunInputSchema.shape,
    },
    async (args) => {
      try {
        const cancel = factory().cancelRun(args.workflowRunId);
        const out = await (activeWork?.track(cancel) ?? cancel);
        const validated = cancelWorkflowRunOutputSchema.parse(out);
        return { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

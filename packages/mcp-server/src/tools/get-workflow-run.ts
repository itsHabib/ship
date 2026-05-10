/**
 * `get_workflow_run` MCP tool — point lookup of a hydrated `WorkflowRun`
 * by id. Maps to `ShipService.getRun(id)`. `null` from the service
 * surfaces as a JSON-RPC `-32602` "not found" error (matches ED-4 in
 * the Phase 8 task doc — clients shouldn't have to disambiguate a
 * `null` payload from a real result).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipServiceFactory } from "@ship/core";

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getWorkflowRunInputSchema, getWorkflowRunOutputSchema } from "@ship/mcp";

import { mapErrorToMcpError } from "../errors.js";

/** Registers the `get_workflow_run` tool on the given `McpServer`. */
export function registerGetWorkflowRunTool(server: McpServer, factory: ShipServiceFactory): void {
  server.registerTool(
    "get_workflow_run",
    {
      description: "Fetch the durable state of a workflow run by id.",
      inputSchema: getWorkflowRunInputSchema.shape,
    },
    async (args) => {
      try {
        const run = await factory().getRun(args.workflowRunId);
        if (run === null) {
          throw new McpError(ErrorCode.InvalidParams, `not found: ${args.workflowRunId}`);
        }
        const validated = getWorkflowRunOutputSchema.parse(run);
        return { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

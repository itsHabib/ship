/**
 * `list_workflow_runs` MCP tool — filter + paginate workflow runs.
 * Maps to `ShipService.listRuns(filter)`. The filter shape is
 * pass-through to the store; an over-cap `--limit` surfaces as a
 * `RangeError`, which `mapErrorToMcpError` routes to `-32602`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipServiceFactory } from "@ship/core";

import { listWorkflowRunsInputSchema, listWorkflowRunsOutputSchema } from "@ship/mcp";

import { mapErrorToMcpError } from "../errors.js";

/** Registers the `list_workflow_runs` tool on the given `McpServer`. */
export function registerListWorkflowRunsTool(server: McpServer, factory: ShipServiceFactory): void {
  server.registerTool(
    "list_workflow_runs",
    {
      description: "List workflow runs with optional repo / status / limit filters.",
      inputSchema: listWorkflowRunsInputSchema.shape,
    },
    async (args) => {
      try {
        // Spread only the keys that are defined — `exactOptionalPropertyTypes`
        // rejects passing `{ repo: undefined }` to a schema that types
        // `repo` as `string | undefined` only when the property is absent.
        const filter = {
          ...(args.repo !== undefined && { repo: args.repo }),
          ...(args.status !== undefined && { status: args.status }),
          ...(args.limit !== undefined && { limit: args.limit }),
        };
        const runs = await factory().listRuns(filter);
        const validated = listWorkflowRunsOutputSchema.parse({ runs });
        return { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

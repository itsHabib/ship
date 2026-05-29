/**
 * `list_artifacts` MCP tool — returns the persisted cloud artifact manifest.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipServiceFactory } from "@ship/core";

import { listArtifactsInputSchema, listArtifactsOutputSchema } from "@ship/mcp";

import { mapErrorToMcpError } from "../errors.js";

/** Registers the `list_artifacts` tool on the given `McpServer`. */
export function registerListArtifactsTool(server: McpServer, factory: ShipServiceFactory): void {
  server.registerTool(
    "list_artifacts",
    {
      description:
        "List cloud artifact refs captured for a workflow run (manifest only, no bytes).",
      inputSchema: listArtifactsInputSchema.shape,
    },
    async (args) => {
      try {
        const artifacts = await factory().listArtifacts(args.workflowRunId);
        const validated = listArtifactsOutputSchema.parse({ artifacts });
        return { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

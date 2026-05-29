/**
 * `download_artifact` MCP tool — fetches one cloud artifact to local disk.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipServiceFactory } from "@ship/core";

import { downloadArtifactInputSchema, downloadArtifactOutputSchema } from "@ship/mcp";

import { mapErrorToMcpError } from "../errors.js";

/** Registers the `download_artifact` tool on the given `McpServer`. */
export function registerDownloadArtifactTool(server: McpServer, factory: ShipServiceFactory): void {
  server.registerTool(
    "download_artifact",
    {
      description:
        "Download a cloud artifact by SDK path into the run artifacts directory (preflight size guard).",
      inputSchema: downloadArtifactInputSchema.shape,
    },
    async (args) => {
      try {
        const out = await factory().downloadArtifact(args.workflowRunId, args.path, {
          ...(args.force !== undefined && { force: args.force }),
        });
        const validated = downloadArtifactOutputSchema.parse(out);
        return { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

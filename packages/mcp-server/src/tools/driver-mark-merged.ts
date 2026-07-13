/**
 * `driver_mark_merged` MCP tool — record merge facts for a landed stream.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { driverMarkMergedInputSchema, driverMarkMergedOutputSchema } from "@ship/mcp";

import type { DriverServiceFactory } from "../driver-service.js";

import { mapErrorToMcpError } from "../errors.js";

export function registerDriverMarkMergedTool(
  server: McpServer,
  factory: DriverServiceFactory,
): void {
  server.registerTool(
    "driver_mark_merged",
    {
      description: "Record merge facts for a landed stream.",
      inputSchema: driverMarkMergedInputSchema.shape,
    },
    (args) => {
      try {
        const validated = driverMarkMergedInputSchema.parse(args);
        const run = factory().markMerged(validated.driverRunId, validated.streamId, {
          mergeCommit: validated.sha,
          prNumber: validated.prNumber,
          ...(validated.mergedAt !== undefined ? { mergedAt: validated.mergedAt } : {}),
          ...(validated.cycles !== undefined ? { cycles: validated.cycles } : {}),
        });
        const validatedOut = driverMarkMergedOutputSchema.parse({
          driverRunId: run.id,
          status: run.status,
        });
        return { content: [{ type: "text", text: JSON.stringify(validatedOut) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

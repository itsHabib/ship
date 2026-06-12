/**
 * `driver_decide` MCP tool — apply a judgment decision (spec §6).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { driverDecideInputSchema, driverDecideOutputSchema } from "@ship/mcp";

import type { DriverServiceFactory } from "../driver-service.js";

import { mapErrorToMcpError } from "../errors.js";

export function registerDriverDecideTool(server: McpServer, factory: DriverServiceFactory): void {
  server.registerTool(
    "driver_decide",
    {
      description: "Apply a stream judgment decision (retry, skip, abort, adopt).",
      inputSchema: driverDecideInputSchema.shape,
    },
    (args) => {
      try {
        const validated = driverDecideInputSchema.parse(args);
        const run = factory().decide(validated.driverRunId, validated.streamId, validated.decision);
        const validatedOut = driverDecideOutputSchema.parse({
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

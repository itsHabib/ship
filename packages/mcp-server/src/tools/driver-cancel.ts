/**
 * `driver_cancel` MCP tool — cancel an in-flight driver run.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { driverCancelInputSchema, driverCancelOutputSchema } from "@ship/mcp";

import type { DriverServiceFactory } from "../driver-service.js";

import { mapErrorToMcpError } from "../errors.js";

export function registerDriverCancelTool(server: McpServer, factory: DriverServiceFactory): void {
  server.registerTool(
    "driver_cancel",
    {
      description: "Cancel an in-flight driver run; idempotent on terminal runs.",
      inputSchema: driverCancelInputSchema.shape,
    },
    async (args) => {
      try {
        const validated = driverCancelInputSchema.parse(args);
        const run = await factory().cancel(validated.driverRunId);
        const validatedOut = driverCancelOutputSchema.parse({
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

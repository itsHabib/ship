/**
 * `driver_status` MCP tool — durable driver run view (spec §6).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DriverRunNotFoundEngineError } from "@ship/driver";
import { driverStatusInputSchema, driverStatusOutputSchema } from "@ship/mcp";

import type { DriverServiceFactory } from "../driver-service.js";

import { buildDriverStatusView } from "../driver-status-view.js";
import { mapErrorToMcpError } from "../errors.js";

export function registerDriverStatusTool(server: McpServer, factory: DriverServiceFactory): void {
  server.registerTool(
    "driver_status",
    {
      description:
        "Fetch durable driver run state, including manifest-modified drift when applicable.",
      inputSchema: driverStatusInputSchema.shape,
    },
    (args) => {
      try {
        const validated = driverStatusInputSchema.parse(args);
        const run = factory().getDriverRun(validated.driverRunId);
        if (run === null) {
          throw new McpError(ErrorCode.InvalidParams, `not found: ${validated.driverRunId}`);
        }
        const view = buildDriverStatusView(run);
        const validatedOut = driverStatusOutputSchema.parse(view);
        return { content: [{ type: "text", text: JSON.stringify(validatedOut) }] };
      } catch (err) {
        if (err instanceof DriverRunNotFoundEngineError) {
          throw new McpError(ErrorCode.InvalidParams, err.message);
        }
        throw mapErrorToMcpError(err);
      }
    },
  );
}

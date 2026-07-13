/**
 * `driver_render` MCP tool — render driver.md from store rows.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { driverRenderInputSchema } from "@ship/mcp";

import type { DriverServiceFactory } from "../driver-service.js";

import { mapErrorToMcpError } from "../errors.js";

export function registerDriverRenderTool(server: McpServer, factory: DriverServiceFactory): void {
  server.registerTool(
    "driver_render",
    {
      description: "Render driver.md from durable store rows.",
      inputSchema: driverRenderInputSchema.shape,
    },
    (args) => {
      try {
        const validated = driverRenderInputSchema.parse(args);
        const text = factory().render(validated.driverRunId);
        const body = text.endsWith("\n") ? text : `${text}\n`;
        return { content: [{ type: "text", text: body }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

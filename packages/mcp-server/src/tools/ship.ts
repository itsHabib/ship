/**
 * `ship` MCP tool — start a workflow run from an approved task doc.
 * Maps the validated input to `ShipService.ship(input)` and returns the
 * resulting `ShipOutput` as a single text content block.
 *
 * Output validation (`shipOutputSchema.parse`) is defense-in-depth so
 * service-side schema drift is caught before reaching a client.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipServiceFactory } from "@ship/core";

import { shipInputSchema, shipOutputSchema } from "@ship/mcp";

import { mapErrorToMcpError } from "../errors.js";

/** Registers the `ship` tool on the given `McpServer`. Idempotent within a server lifetime. */
export function registerShipTool(server: McpServer, factory: ShipServiceFactory): void {
  server.registerTool(
    "ship",
    {
      description: "Start a workflow run from an approved task doc.",
      inputSchema: shipInputSchema.shape,
    },
    async (args) => {
      try {
        const out = await factory().ship(args);
        const validated = shipOutputSchema.parse(out);
        return { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

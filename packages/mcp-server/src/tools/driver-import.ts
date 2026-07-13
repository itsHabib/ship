/**
 * `driver_import` MCP tool — import a driver.md manifest into the store.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { driverImportInputSchema, driverImportOutputSchema } from "@ship/mcp";
import { isAbsolute } from "node:path";

import type { DriverServiceFactory } from "../driver-service.js";

import { mapErrorToMcpError } from "../errors.js";

export function registerDriverImportTool(server: McpServer, factory: DriverServiceFactory): void {
  server.registerTool(
    "driver_import",
    {
      description: "Import a driver.md manifest into the store.",
      inputSchema: driverImportInputSchema.shape,
    },
    (args) => {
      try {
        const validated = driverImportInputSchema.parse(args);
        if (!isAbsolute(validated.manifestPath)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `manifestPath must be absolute: ${validated.manifestPath}`,
          );
        }
        const result = factory().importManifest(validated.manifestPath);
        const validatedOut = driverImportOutputSchema.parse({
          driverRunId: result.run.id,
          ...(result.warnings !== undefined && result.warnings.length > 0
            ? { warnings: result.warnings }
            : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(validatedOut) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

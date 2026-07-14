/**
 * `driver_render` MCP tool — render driver.md from store rows.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { driverRenderInputSchema, driverRenderWrittenOutputSchema } from "@ship/mcp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

import type { DriverServiceFactory } from "../driver-service.js";

import { mapErrorToMcpError } from "../errors.js";

export function registerDriverRenderTool(server: McpServer, factory: DriverServiceFactory): void {
  server.registerTool(
    "driver_render",
    {
      description: "Render driver.md from store rows.",
      inputSchema: driverRenderInputSchema.shape,
    },
    (args) => {
      try {
        const validated = driverRenderInputSchema.parse(args);
        const text = factory().render(validated.driverRunId);
        if (validated.outPath !== undefined) {
          if (!isAbsolute(validated.outPath)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `outPath must be absolute: ${validated.outPath}`,
            );
          }
          const outPath = resolvePath(validated.outPath);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, text, "utf8");
          const validatedOut = driverRenderWrittenOutputSchema.parse({
            written: true,
            outPath,
          });
          return { content: [{ type: "text", text: JSON.stringify(validatedOut) }] };
        }
        const rendered = text.endsWith("\n") ? text : `${text}\n`;
        return { content: [{ type: "text", text: rendered }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

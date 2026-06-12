/**
 * `driver_run` MCP tool — one bounded engine tick (spec §6).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { driverRunInputSchema, driverTickResultSchema } from "@ship/mcp";

import type { DriverServiceFactory } from "../driver-service.js";

import { mapErrorToMcpError } from "../errors.js";

export function registerDriverRunTool(server: McpServer, factory: DriverServiceFactory): void {
  server.registerTool(
    "driver_run",
    {
      description:
        "Run one bounded driver engine tick. Defaults to maxWaitMs=0 (one dispatch + scan pass); callers poll by re-invoking.",
      inputSchema: driverRunInputSchema.innerType().shape,
    },
    async (args) => {
      try {
        const validated = driverRunInputSchema.parse(args);
        const ref =
          validated.driverRunId !== undefined
            ? { driverRunId: validated.driverRunId }
            : { manifestPath: validated.manifestPath ?? "" };
        const result = await factory().run(ref, {
          ...(validated.batch !== undefined ? { batch: validated.batch } : {}),
          force: validated.force === true,
          maxWaitMs: validated.maxWaitMs,
          ...(validated.pollIntervalMs !== undefined
            ? { pollIntervalMs: validated.pollIntervalMs }
            : {}),
        });
        const validatedOut = driverTickResultSchema.parse(result);
        return { content: [{ type: "text", text: JSON.stringify(validatedOut) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

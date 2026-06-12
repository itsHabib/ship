/**
 * `driver_run` MCP tool — one bounded engine tick (spec §6).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DriverRunRef } from "@ship/driver";
import type { DriverRunInput } from "@ship/mcp";

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { driverRunInputSchema, driverTickResultSchema } from "@ship/mcp";
import { isAbsolute } from "node:path";

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
        const result = await factory().run(toDriverRunRef(validated), {
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

function toDriverRunRef(input: DriverRunInput): DriverRunRef {
  if (input.driverRunId !== undefined) return { driverRunId: input.driverRunId };
  if (input.manifestPath !== undefined) {
    // The MCP server's cwd is not meaningful to callers — a relative
    // path would resolve against wherever the host launched the server.
    if (!isAbsolute(input.manifestPath)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `manifestPath must be absolute: ${input.manifestPath}`,
      );
    }
    return { manifestPath: input.manifestPath };
  }
  throw new Error("unreachable: schema requires exactly one of driverRunId or manifestPath");
}

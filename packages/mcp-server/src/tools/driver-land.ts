/**
 * `driver_land` MCP tool — merge PR, read sha/time from gh, record merge facts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { driverLandInputSchema, driverLandOutputSchema } from "@ship/mcp";

import type { ActiveWorkTracker } from "../active-work.js";
import type { DriverServiceFactory } from "../driver-service.js";

import { mapErrorToMcpError } from "../errors.js";

export function registerDriverLandTool(
  server: McpServer,
  factory: DriverServiceFactory,
  activeWork?: ActiveWorkTracker,
): void {
  server.registerTool(
    "driver_land",
    {
      description:
        "Merge a PR (if needed), read merge commit sha and merged-at from gh, and record merge facts for a landed stream.",
      inputSchema: driverLandInputSchema.shape,
    },
    async (args) => {
      try {
        const validated = driverLandInputSchema.parse(args);
        const land = factory().land(validated.driverRunId, {
          prNumber: validated.prNumber,
          ...(validated.streamId !== undefined ? { streamId: validated.streamId } : {}),
          ...(validated.cycles !== undefined ? { cycles: validated.cycles } : {}),
          ...(validated.admin !== undefined ? { admin: validated.admin } : {}),
          ...(validated.reviewedHeadSha !== undefined
            ? { reviewedHeadSha: validated.reviewedHeadSha }
            : {}),
          ...(validated.gateRunRef !== undefined ? { gateRunRef: validated.gateRunRef } : {}),
        });
        const run = await (activeWork?.track(land) ?? land);
        const validatedOut = driverLandOutputSchema.parse({
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

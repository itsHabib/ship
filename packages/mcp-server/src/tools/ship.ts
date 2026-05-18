/**
 * `ship` MCP tool — start a workflow run from an approved task doc.
 * Maps the validated input to `ShipService.startShip(input)` and returns
 * `{ workflowRunId, status: "running" }` immediately after the row + initial
 * phase row are persisted and transitioned to `running`. The Cursor agent
 * continues on a background tick; callers poll `get_workflow_run` for the
 * terminal `WorkflowRun` shape. See `docs/features/ship-v2/phases/01-async-ship-tool.md`.
 *
 * Output validation (`shipStartOutputSchema.parse`) is defense-in-depth so
 * service-side schema drift is caught before reaching a client.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipServiceFactory } from "@ship/core";

import { shipInputSchema, shipStartOutputSchema } from "@ship/mcp";

import { mapErrorToMcpError } from "../errors.js";

/** Registers the `ship` tool on the given `McpServer`. Idempotent within a server lifetime. */
export function registerShipTool(server: McpServer, factory: ShipServiceFactory): void {
  server.registerTool(
    "ship",
    {
      description:
        "Start a workflow run from an approved task doc. Returns immediately with { workflowRunId, status: 'running' }; poll get_workflow_run for terminal state.",
      // `shipInputSchema` is wrapped in a `.superRefine()` (ZodEffects) for the
      // cross-field `runtime === "cloud" ⇒ cloud required` check, so `.shape`
      // lives on the inner ZodObject. Cross-field validation runs on `.parse()`
      // but doesn't surface in the JSONSchema-shaped tool input descriptor.
      inputSchema: shipInputSchema.innerType().shape,
    },
    async (args) => {
      try {
        const out = await factory().startShip(args);
        const validated = shipStartOutputSchema.parse(out);
        return { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

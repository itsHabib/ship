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
      // `shipInputSchema` is wrapped in `.superRefine()` (ZodEffects) so `.shape`
      // lives on the inner ZodObject. The SDK rebuilds a `ZodObject` from this
      // shape for pre-handler validation — that path only checks field-level
      // types, never the cross-field refinement. The handler re-parses with the
      // full schema below so the `runtime === "cloud" ⇒ cloud required`
      // invariant fires at the MCP boundary instead of deep in the runner after
      // workflow state has been persisted.
      inputSchema: shipInputSchema.innerType().shape,
    },
    async (args) => {
      try {
        const validated = shipInputSchema.parse(args);
        const out = await factory().startShip(validated);
        const validatedOut = shipStartOutputSchema.parse(out);
        return { content: [{ type: "text", text: JSON.stringify(validatedOut) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

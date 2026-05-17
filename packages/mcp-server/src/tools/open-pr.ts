// `open_pr` MCP tool — push a workflow run's branch and open a PR
// via `OpenPrService`. Synchronous on the MCP boundary (sub-second
// happy path); the design doc § F4 justifies skipping the
// async-start pattern the `ship` tool uses.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenPrServiceFactory } from "@ship/core";

import { openPrInputSchema, openPrOutputSchema } from "@ship/mcp";

import { mapErrorToMcpError } from "../errors.js";

/** Registers the `open_pr` tool on the given `McpServer`. */
export function registerOpenPrTool(server: McpServer, factory: OpenPrServiceFactory): void {
  server.registerTool(
    "open_pr",
    {
      description:
        "Push a workflow run's branch and open a PR. Returns immediately with the PR number/url; idempotent against an existing open PR for the same head/base.",
      inputSchema: openPrInputSchema.shape,
    },
    async (args) => {
      try {
        const out = await factory().openPr(args);
        const validated = openPrOutputSchema.parse(out);
        return { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

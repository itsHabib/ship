/**
 * `ship://runs/{id}` MCP resource — read-only view of a hydrated
 * `WorkflowRun` by id. Returns `application/json`-typed text content
 * matching `getWorkflowRunOutputSchema`. Unknown id surfaces as
 * JSON-RPC `-32602` "not found" so MCP clients can disambiguate from
 * a real result without parsing the body. Mirrors `get_workflow_run`'s
 * tool behavior in F2 / ED-4 of the Phase 8 task doc.
 *
 * The handler reads the variable directly from the SDK-supplied
 * `Variables` record (not by re-parsing the URI) — the SDK already
 * extracted `{id}` against the URI template before invoking us.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipServiceFactory } from "@ship/core";

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getWorkflowRunOutputSchema } from "@ship/mcp";

import { mapErrorToMcpError } from "../errors.js";

const URI_TEMPLATE = "ship://runs/{id}";
const MIME_JSON = "application/json";

/**
 * Registers the single read-only `ship://runs/{id}` resource on the
 * given `McpServer`. V1 doesn't advertise resource subscriptions — the
 * caller must re-read to pick up changes.
 */
export function registerRunsResource(server: McpServer, factory: ShipServiceFactory): void {
  const template = new ResourceTemplate(URI_TEMPLATE, { list: undefined });
  server.registerResource(
    "ship-run",
    template,
    {
      description:
        "Read the durable state of a workflow run by id. Cloud runs may include watchUrl (live Cursor dashboard link) and cursorAgentId at the top level.",
      mimeType: MIME_JSON,
    },
    async (uri, variables) => {
      try {
        const id = extractId(variables["id"]);
        const run = await factory().getRun(id);
        if (run === null) {
          throw new McpError(ErrorCode.InvalidParams, `not found: ${id}`);
        }
        const validated = getWorkflowRunOutputSchema.parse(run);
        return {
          contents: [{ uri: uri.toString(), mimeType: MIME_JSON, text: JSON.stringify(validated) }],
        };
      } catch (err) {
        throw mapErrorToMcpError(err);
      }
    },
  );
}

/**
 * Pulls the `id` template variable as a single string. RFC 6570 allows
 * comma-separated lists, so the SDK types `Variables[k]` as
 * `string | string[]`; for `ship://runs/{id}` we only ever expect a
 * single value, and a plural is a malformed URI we reject as
 * `-32602`.
 */
function extractId(value: string | string[] | undefined): string {
  if (typeof value === "string" && value !== "") return value;
  throw new McpError(ErrorCode.InvalidParams, "ship://runs/{id} requires a non-empty id");
}

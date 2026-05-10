/**
 * Pure factory: builds the `McpServer` and registers all four V1 tools
 * plus the single `ship://runs/{id}` resource against the given
 * `ShipServiceFactory`. No transport, no env reads — `bin.ts` and the
 * in-memory smoke tests both call this then attach a transport of
 * their own choosing. Keeping this layer pure is what lets the unit
 * tests use `InMemoryTransport` while the integration test uses
 * `StdioServerTransport`.
 */

import type { ShipServiceFactory } from "@ship/core";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerRunsResource } from "./resources/runs.js";
import { registerCancelWorkflowRunTool } from "./tools/cancel-workflow-run.js";
import { registerGetWorkflowRunTool } from "./tools/get-workflow-run.js";
import { registerListWorkflowRunsTool } from "./tools/list-workflow-runs.js";
import { registerShipTool } from "./tools/ship.js";

/** Server name reported via the MCP `initialize` handshake. */
const SERVER_NAME = "ship";
/**
 * Tracks `packages/mcp-server/package.json#version` — every other
 * workspace package is also at `0.0.0` pre-publish, and the MCP
 * `initialize` metadata should not lie about the build it's served
 * from. Bump this in lock-step with `package.json` when we publish.
 * (The Phase 8 doc Open Question 4 proposed `0.1.0`; deferred to the
 * actual publish PR for consistency with the rest of the workspace.)
 */
const SERVER_VERSION = "0.0.0";

/**
 * Constructs an `McpServer` with all four V1 tools and the runs
 * resource registered. Tools/resources auto-register `tools.listChanged`
 * and `resources.listChanged` capabilities through the SDK's high-level
 * `McpServer` class — no manual capability block needed.
 */
export function buildServer(factory: ShipServiceFactory): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerShipTool(server, factory);
  registerGetWorkflowRunTool(server, factory);
  registerListWorkflowRunsTool(server, factory);
  registerCancelWorkflowRunTool(server, factory);
  registerRunsResource(server, factory);
  return server;
}

// Pure factory: builds the `McpServer` and registers all V1 tools plus
// the single `ship://runs/{id}` resource against the given
// `ShipServiceFactory`. No transport, no env reads — `bin.ts` and the
// in-memory smoke tests both call this then attach a transport of their
// own choosing. Keeping this layer pure is what lets the unit tests use
// `InMemoryTransport` while the integration test uses
// `StdioServerTransport`.

import type { ShipServiceFactory } from "@ship/core";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DriverServiceFactory } from "./driver-service.js";

import { registerRunsResource } from "./resources/runs.js";
import { registerCancelWorkflowRunTool } from "./tools/cancel-workflow-run.js";
import { registerDownloadArtifactTool } from "./tools/download-artifact.js";
import { registerDriverDecideTool } from "./tools/driver-decide.js";
import { registerDriverRunTool } from "./tools/driver-run.js";
import { registerDriverStatusTool } from "./tools/driver-status.js";
import { registerGetWorkflowRunTool } from "./tools/get-workflow-run.js";
import { registerListArtifactsTool } from "./tools/list-artifacts.js";
import { registerListWorkflowRunsTool } from "./tools/list-workflow-runs.js";
import { registerShipTool } from "./tools/ship.js";

// Server name reported via the MCP `initialize` handshake.
const SERVER_NAME = "ship";
// Tracks `packages/mcp-server/package.json#version` — every other
// workspace package is also at `0.0.0` pre-publish, and the MCP
// `initialize` metadata should not lie about the build it's served
// from. Bump this in lock-step with `package.json` when we publish.
const SERVER_VERSION = "0.0.0";

// Constructs an `McpServer` with every Ship tool + the runs resource
// registered. Tools/resources auto-register `tools.listChanged` and
// `resources.listChanged` capabilities through the SDK's high-level
// `McpServer` class — no manual capability block needed.
export function buildServer(
  shipFactory: ShipServiceFactory,
  driverFactory?: DriverServiceFactory,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerShipTool(server, shipFactory);
  registerGetWorkflowRunTool(server, shipFactory);
  registerListWorkflowRunsTool(server, shipFactory);
  registerCancelWorkflowRunTool(server, shipFactory);
  registerListArtifactsTool(server, shipFactory);
  registerDownloadArtifactTool(server, shipFactory);
  if (driverFactory !== undefined) {
    registerDriverRunTool(server, driverFactory);
    registerDriverStatusTool(server, driverFactory);
    registerDriverDecideTool(server, driverFactory);
  }
  registerRunsResource(server, shipFactory);
  return server;
}

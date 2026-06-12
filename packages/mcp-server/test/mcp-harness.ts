/**
 * Test helper — pairs a fake-cursor-backed `ShipService` (in-memory
 * store + `MemoryShipFs`) with an `McpServer` over an
 * `InMemoryTransport` so each tool / resource test can exchange
 * JSON-RPC requests with the server in-process. Mirrors the CLI's
 * `cli-harness.ts` shape (Phase 7) so reviewers can switch between
 * the two without re-learning the layout.
 *
 * Lives under `test/` (not `src/`) so vitest's coverage `include`
 * glob (`src/**`) doesn't count this helper as production code.
 */

import type { ShipService, ShipServiceFactory } from "@ship/core";
import type { DriverService } from "@ship/driver";
import type { Harness, ServiceBundle } from "@ship/test-harness";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createDriverService } from "@ship/driver";
import { createHarness, createServiceFromHarness } from "@ship/test-harness";

import type { DriverServiceFactory } from "../src/driver-service.js";

import { buildServer } from "../src/server.js";

// Re-export the shared poll-to-terminal helper so existing callsites
// (`import { waitForTerminalRun } from "../../test/mcp-harness.js"`)
// keep working without an extra import line. The canonical impl lives
// in `@ship/test-harness`.
export { waitForTerminalRun } from "@ship/test-harness";

/** Default workdir created inside the in-memory FS so the `ship` tool can stat it. */
export const TEST_WORKDIR = "/work/wt/feat";
/** Default doc path inside `TEST_WORKDIR`. */
export const TEST_DOC_PATH = "docs.md";

// What `createMcpHarness` hands back to a calling test.
export interface McpHarness {
  readonly client: Client;
  readonly service: ShipService;
  readonly driver: DriverService;
  readonly bundle: ServiceBundle;
  readonly harness: Harness;
  readonly cloudCursor: FakeCursorRunner;
  readonly factory: ShipServiceFactory;
  readonly close: () => Promise<void>;
}

// Constructs a fully-wired in-process MCP harness: in-memory store +
// fs + fake cursor + an `McpServer` connected to a `Client` over an
// in-memory transport pair. Pre-creates the test workdir + a sample
// doc so the `ship` tool's pre-row validation passes by default.
export async function createMcpHarness(): Promise<McpHarness> {
  const harness = createHarness();
  const cloudCursor = new FakeCursorRunner();
  const bundle = createServiceFromHarness(harness, { cloudCursor });
  await bundle.fs.mkdir(TEST_WORKDIR, { recursive: true });
  await bundle.fs.writeFile(`${TEST_WORKDIR}/${TEST_DOC_PATH}`, "# Task\n\nDo it.\n");

  const factory: ShipServiceFactory = () => bundle.service;
  const driverFactory: DriverServiceFactory = () =>
    createDriverService({ ship: bundle.service, store: harness.store });
  const driver = driverFactory();
  const server = buildServer(factory, driverFactory);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ship-mcp-test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    service: bundle.service,
    driver,
    bundle,
    harness,
    cloudCursor,
    factory,
    close: async () => {
      await client.close();
      await server.close();
      // Drain any in-flight `startShip` continuations BEFORE closing
      // the store. Without this, a setImmediate continuation that
      // races past `harness.close()` hits a closed SQLite handle and
      // leaks "background continuation rejected after finalize" to
      // stderr.
      await bundle.service.drainBackground();
      harness.close();
    },
  };
}

/**
 * Convenience parser for tool responses — every V1 tool returns a
 * single text content block whose `text` is JSON. Throws if the shape
 * doesn't match (e.g. the SDK returned an error result instead).
 * Returns `unknown` so the call site narrows via its own cast or
 * runtime check; that keeps this helper free of unused type
 * parameters (lint rule).
 */
export function parseToolJson(result: unknown): unknown {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const block = r.content?.[0];
  if (block?.type !== "text" || typeof block.text !== "string") {
    throw new Error(`unexpected tool response shape: ${JSON.stringify(result)}`);
  }
  if (r.isError === true) {
    throw new Error(`tool returned isError: ${block.text}`);
  }
  return JSON.parse(block.text);
}

/**
 * The MCP SDK reports tool-handler errors as `{ content: [...], isError: true }`
 * results rather than rejecting the JSON-RPC promise (this includes both
 * Zod input-validation errors that the SDK runs pre-handler and any error
 * thrown inside the handler). Tests assert on the error text via this helper
 * so the assertion lines stay symmetric with the happy-path lines.
 */
export function expectToolError(result: unknown): { text: string } {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  if (r.isError !== true) {
    throw new Error(`expected isError, got: ${JSON.stringify(result)}`);
  }
  const block = r.content?.[0];
  const text = typeof block?.text === "string" ? block.text : "";
  return { text };
}

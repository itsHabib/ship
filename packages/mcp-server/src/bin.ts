#!/usr/bin/env node
/**
 * `@ship/mcp-server` entrypoint. Wires the production `ShipService`
 * (`createDefaultShipService` from `@ship/core`), builds the server
 * with all four V1 tools + the runs resource, and connects to stdio.
 *
 * Pre-flight rejects when `CURSOR_API_KEY` is missing — same loud
 * failure mode as Phase 7's CLI risk-section recommendation. The
 * `SHIP_TEST_FAKE_CURSOR=1` env var is the one production-side
 * carve-out for the L3 subprocess integration test (ED-7); it
 * substitutes `FakeCursorRunner` so the test harness can spawn the
 * real binary without burning real model quota.
 *
 * Path resolution mirrors the human-facing CLI binary: env-var
 * override (`SHIP_DB_PATH` / `SHIP_RUNS_DIR`), falling back to
 * `<UserConfigDir>/ship/{state.db, runs/}`. The CLI's `userConfigDir`
 * helper is intentionally NOT consumed here — that would invert the
 * dep direction. We re-derive the same XDG / APPDATA lookup inline;
 * tests pin the equivalence.
 */

import type { CursorRunner } from "@ship/cursor-runner";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultShipService } from "@ship/core";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createLogger } from "@ship/logger";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { createMcpDriverServiceFactory } from "./driver-service.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const logger = createLogger({ stream: process.stderr });
  const useFake = process.env["SHIP_TEST_FAKE_CURSOR"] === "1";
  // Treat both "unset" and "set to empty string" as missing — the
  // Cursor SDK rejects an empty key the same way it rejects an
  // absent one, so accepting `""` here would let the server start
  // and silently fail every real `ship` call instead of failing
  // fast at boot. Cycle-1 review (ship#15) caught this gap.
  const apiKey = process.env["CURSOR_API_KEY"];
  if (!useFake && (apiKey === undefined || apiKey === "")) {
    logger.error({}, "CURSOR_API_KEY is not set");
    process.exitCode = 1;
    return;
  }

  const dbPath = process.env["SHIP_DB_PATH"] ?? join(userConfigDir(), "ship", "state.db");
  const runsDir = process.env["SHIP_RUNS_DIR"] ?? join(userConfigDir(), "ship", "runs");

  const opts: Parameters<typeof createDefaultShipService>[0] = { dbPath, runsDir, logger };
  if (useFake) {
    // The fake runner returns a fixed `succeeded` outcome for every
    // `ship` call so the L3 subprocess test exercises the stdio /
    // SDK / persistence path without needing test-side enqueueing.
    // Cursor behavior is covered by the cursor-runner unit tests.
    const fake: CursorRunner = new FakeCursorRunner({
      defaultScript: {
        events: [],
        result: { status: "succeeded", durationMs: 0, branches: [] },
      },
    });
    Object.assign(opts, { cursor: fake });
  }
  const shipFactory = createDefaultShipService(opts);
  const driverFactory = createMcpDriverServiceFactory(opts, shipFactory);
  const server = buildServer(shipFactory, driverFactory);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Mirrors `@ship/cli/src/service.ts#userConfigDir` — duplicated rather
 * than imported to avoid an mcp-server → cli dep. POSIX honors
 * `XDG_CONFIG_HOME` (only when absolute, per the XDG spec); Windows
 * reads `%APPDATA%`.
 */
function userConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData !== undefined && appData !== "") return appData;
    return join(homedir(), "AppData", "Roaming");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return xdg;
  return join(homedir(), ".config");
}

main().catch((err: unknown) => {
  const logger = createLogger({ stream: process.stderr });
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "mcp-server bootstrap failed");
  process.exitCode = 2;
});

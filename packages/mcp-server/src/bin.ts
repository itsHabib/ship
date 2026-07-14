#!/usr/bin/env node
/**
 * `@ship/mcp-server` entrypoint. Wires the production `ShipService`
 * (`createDefaultShipService` from `@ship/core`), builds the server
 * with the workflow, artifact, and driver tools plus the runs resource, and
 * connects to stdio.
 *
 * Provider credentials are validated by the selected runner when a
 * `ship` request is dispatched. The server itself stays provider-neutral,
 * so Claude/Codex requests do not require a Cursor credential. The
 * `SHIP_TEST_FAKE_CURSOR=1` env var is the one production-side
 * carve-out for the L3 subprocess integration test (ED-7); it
 * substitutes `FakeCursorRunner` so the test harness can spawn the
 * real binary without burning real model quota.
 *
 * Path resolution mirrors the human-facing CLI binary: an ABSOLUTE
 * env-var override (`SHIP_DB_PATH` / `SHIP_RUNS_DIR`) wins, else it
 * falls back to `<UserConfigDir>/ship/{state.db, runs/}`. A relative /
 * empty env value is rejected identically on both surfaces so one
 * machine never splits into two stores. The resolvers live in
 * `./store-paths.ts` (re-derived from the CLI's shape, not imported —
 * that would invert the dep direction); an L1 parity matrix pins the
 * equivalence.
 */

import type { AgentRunner } from "@ship/cursor-runner";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultShipService, ORPHAN_RESUME_STALENESS_MS } from "@ship/core";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createLogger } from "@ship/logger";

import { createMcpDriverServiceFactory } from "./driver-service.js";
import { buildServer } from "./server.js";
import { resolveDbPath, resolveRunsDir } from "./store-paths.js";

async function main(): Promise<void> {
  const logger = createLogger({ stream: process.stderr });
  const useFake = process.env["SHIP_TEST_FAKE_CURSOR"] === "1";

  const dbPath = resolveDbPath();
  const runsDir = resolveRunsDir();

  const opts: Parameters<typeof createDefaultShipService>[0] = {
    dbPath,
    runsDir,
    logger,
    resumeOrphans: true,
  };
  if (useFake) {
    // The fake runner returns a fixed `succeeded` outcome for every
    // `ship` call so the L3 subprocess test exercises the stdio /
    // SDK / persistence path without needing test-side enqueueing.
    // Cursor behavior is covered by the cursor-runner unit tests.
    const fake: AgentRunner = new FakeCursorRunner({
      defaultScript: {
        events: [],
        result: { status: "succeeded", durationMs: 0, branches: [] },
      },
    });
    // One fake serves both runtimes — cloud-runtime dispatches must
    // not construct a real CloudCursorRunner in fake mode.
    Object.assign(opts, { cursor: fake, cloudCursor: fake });
  }
  const shipFactory = createDefaultShipService(opts);
  const driverFactory = createMcpDriverServiceFactory(opts, shipFactory);
  // The factory is lazy and tool registration never invokes it — construct
  // eagerly so the boot orphan sweep actually runs on an idle server.
  shipFactory();
  startOrphanResweep(shipFactory, logger);
  const server = buildServer(shipFactory, driverFactory);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Periodic orphan re-sweep. The boot sweep skips rows with a fresh
 * heartbeat (a crash leaves ~5 minutes of apparent freshness behind), so
 * a one-shot sweep would strand a run orphaned just before this process
 * started. Re-sweeping at the staleness cadence adopts those rows once
 * they age past the threshold; live sibling runs keep heartbeating and
 * stay excluded. `unref()` keeps the timer from holding the process open.
 */
function startOrphanResweep(
  shipFactory: ReturnType<typeof createDefaultShipService>,
  logger: ReturnType<typeof createLogger>,
): void {
  const timer = setInterval(() => {
    shipFactory()
      .resumeOrphanedRuns()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, "periodic orphan resume sweep failed");
      });
  }, ORPHAN_RESUME_STALENESS_MS);
  timer.unref();
}

main().catch((err: unknown) => {
  const logger = createLogger({ stream: process.stderr });
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "mcp-server bootstrap failed");
  process.exitCode = 2;
});

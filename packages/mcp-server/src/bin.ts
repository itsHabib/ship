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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShipService } from "@ship/core";
import type { AgentRunner } from "@ship/cursor-runner";
import type { Logger } from "@ship/logger";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  closeDefaultSharedStore,
  createDefaultShipService,
  ORPHAN_RESUME_STALENESS_MS,
} from "@ship/core";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createExecTriageClassifier } from "@ship/driver";
import { createLogger } from "@ship/logger";

import type { ActiveWorkTracker } from "./active-work.js";

import { createActiveWorkTracker } from "./active-work.js";
import { createMcpDriverServiceFactory } from "./driver-service.js";
import { buildServer } from "./server.js";
import {
  awaitPidsGone,
  heartbeatInstance,
  INSTANCE_HEARTBEAT_MS,
  reconcileSingleInstance,
  releaseInstance,
  systemProcessInspector,
} from "./single-instance.js";
import { openStoreWithRetry } from "./store-open.js";
import { resolveDbPath, resolveRunsDir } from "./store-paths.js";

async function main(): Promise<void> {
  const logger = createLogger({ stream: process.stderr });
  const useFake = process.env["SHIP_TEST_FAKE_CURSOR"] === "1";

  const dbPath = resolveDbPath();
  const runsDir = resolveRunsDir();

  // Single-instance guard BEFORE the store opens: reap any prior / orphaned
  // ship mcp-server bound to THIS store so we don't add another long-lived WAL
  // writer. Unbounded accumulation of these (sessions that never exited) is
  // what rotted state.db. Never fatal — a guard failure must not stop a fresh
  // server from serving. Awaits reaped siblings' actual exit so the open below
  // doesn't race the WAL-handle release.
  const selfEntryPath = await installSingleInstance(dbPath, logger);

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
  // Real triage classifier in production only — fake mode never shells out.
  const triage = useFake ? undefined : createExecTriageClassifier();
  const driverFactory = createMcpDriverServiceFactory(opts, shipFactory, undefined, triage);
  const activeWork = createActiveWorkTracker();
  let shipService: ShipService | undefined;
  let resweepTimer: NodeJS.Timeout | undefined;
  // Everything from opening the store onward shares one failure path: on any
  // bootstrap error (corrupt db, or a throw from buildServer/connect after the
  // store opened) release our registry entry and close the store so a retry
  // sees a clean registry and no leaked handle. The lifecycle handlers only
  // fire on a *successful* connect's later disconnect, so they can't cover this.
  try {
    // The factory is lazy and tool registration never invokes it — open eagerly
    // so the boot orphan sweep runs on an idle server. This is also where the
    // integrity gate (quick_check) fires; corruption is terminal (never retried).
    await openStoreWithRetry(
      () => {
        shipService = shipFactory();
      },
      dbPath,
      { logger },
    );
    const service = shipService ?? shipFactory();
    resweepTimer = startOrphanResweep(service, logger);
    const server = buildServer(shipFactory, driverFactory, activeWork);
    // Self-exit on client disconnect / signals: restores the 1:1 session↔server
    // lifecycle so a dead session's server doesn't linger holding the db. Wired
    // BEFORE connect so an immediate transport close can't race an unset hook.
    installLifecycleShutdown({
      server,
      service,
      activeWork,
      dbPath,
      selfEntryPath,
      resweepTimer,
      logger,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (err: unknown) {
    if (resweepTimer !== undefined) clearInterval(resweepTimer);
    await activeWork.drain();
    if (shipService !== undefined) await drainQuietly(shipService, logger);
    releaseSelf(selfEntryPath);
    closeStoreQuietly(dbPath, logger);
    throw err;
  }
}

/**
 * Reap prior/orphaned ship servers on this store, register self, and start the
 * heartbeat that lets a future server tell this live process apart from a
 * reused PID. Returns the registry entry path (for later heartbeat/release), or
 * `undefined` if the guard could not run — availability beats the guard.
 */
async function installSingleInstance(dbPath: string, logger: Logger): Promise<string | undefined> {
  try {
    const startedAtMs = Date.now() - Math.round(process.uptime() * 1000);
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: process.pid,
      startedAtMs,
      nowMs: Date.now(),
      inspector: systemProcessInspector,
      logger,
    });
    if (result.reapedPids.length > 0 || result.removedStalePids.length > 0) {
      logger.info(
        { reaped: result.reapedPids, sweptStale: result.removedStalePids, dbPath },
        "single-instance guard reconciled prior ship mcp-server registry entries",
      );
    }
    // Wait for reaped siblings to actually exit before the store opens — a
    // just-killed WAL holder still owns the file for a beat on Windows.
    const stillAlive = await awaitPidsGone(result.reapedPids, systemProcessInspector);
    // A reaped entry leaves the registry only once its process is confirmed
    // gone. A hung sibling keeps its entry — its heartbeat never recreates a
    // missing one, so deleting here would make it permanently invisible to
    // every future reconcile while it still holds store handles.
    const stillAlivePids = new Set(stillAlive);
    for (const reaped of result.reapedEntries) {
      if (!stillAlivePids.has(reaped.pid)) releaseInstance(reaped.entryPath);
    }
    if (stillAlive.length > 0) {
      logger.warn(
        { stillAlive, dbPath },
        "reaped sibling(s) did not exit before timeout; opening store anyway (open retry guards the race; their registry entries stay visible for the next reconcile)",
      );
    }
    startHeartbeat(result.selfEntryPath);
    return result.selfEntryPath;
  } catch (err: unknown) {
    logger.warn(
      { err: errorText(err), dbPath },
      "single-instance guard failed; continuing without a registry entry",
    );
    return undefined;
  }
}

/** Refresh this server's heartbeat on a timer. `unref()` never holds the process open. */
function startHeartbeat(selfEntryPath: string): void {
  const timer = setInterval(() => {
    try {
      heartbeatInstance(selfEntryPath, Date.now());
    } catch {
      // Best-effort — a missed heartbeat only risks a slower reap next boot.
    }
  }, INSTANCE_HEARTBEAT_MS);
  timer.unref();
}

/**
 * Wire graceful shutdown to transport close + SIGTERM/SIGINT. Idempotent (a
 * disconnect and a signal can both fire): drain in-flight `ship` starts (a
 * `ship` returns `running` and finishes its persistence on a background
 * continuation — closing the store first would strand a just-started local run
 * with no resumable cursor row), then release the registry entry, close the
 * store (checkpoints the WAL), and exit. Draining is a no-op when nothing is
 * pending, so an idle disconnect exits promptly. On Windows SIGTERM is a hard
 * kill (no drain possible); the reaper removes the reaped entry itself — this
 * path is the clean-disconnect and POSIX-signal case.
 */
interface LifecycleShutdownOptions {
  server: McpServer;
  service: ShipService;
  activeWork: ActiveWorkTracker;
  dbPath: string;
  selfEntryPath: string | undefined;
  resweepTimer: NodeJS.Timeout;
  logger: Logger;
}

function installLifecycleShutdown(opts: LifecycleShutdownOptions): void {
  const { activeWork, dbPath, logger, resweepTimer, selfEntryPath, server, service } = opts;
  let closing = false;
  const finishShutdown = async (code: number): Promise<void> => {
    // The SQLite close/checkpoint is the one step that must not be skipped:
    // registry release is best-effort cleanup, and a throw from it (unwritable
    // registry dir, a Windows sharing error) must never leave the WAL
    // unclosed — that is the exact writer-leak this guard exists to prevent.
    // Stop periodic work before taking either drain snapshot. Driver handlers
    // drain first because a driver tick can start a Ship continuation; only
    // then is it safe to snapshot and drain the service's background sets.
    clearInterval(resweepTimer);
    try {
      await activeWork.drain();
      await drainQuietly(service, logger);
      releaseSelf(selfEntryPath);
    } finally {
      closeStoreQuietly(dbPath, logger);
    }
    process.exit(code);
  };
  const shutdown = (code: number, reason: string): void => {
    if (closing) {
      // Only a human's repeated Ctrl+C forces an exit mid-drain. SIGTERM is
      // what a NEW server's reaper sends when this server's client has died
      // while a local run is still finalizing — honoring it would kill the
      // exact run the unbounded drain exists to preserve. Ignoring it is
      // safe: the reaper's awaitPidsGone times out, keeps this entry visible
      // (heartbeat still refreshing), and the next reconcile retries after
      // the drain has closed the store and exited.
      if (reason === "SIGINT") {
        logger.warn({ reason }, "second SIGINT during drain; exiting immediately");
        process.exit(code);
      }
      logger.warn(
        { reason },
        "shutdown signal during active drain ignored (likely a sibling's reaper); finishing the drain",
      );
      return;
    }
    closing = true;
    logger.info({ reason }, "ship mcp-server shutting down");
    finishShutdown(code).catch((err: unknown) => {
      logger.error({ err: errorText(err) }, "shutdown finalize failed; exiting anyway");
      process.exit(code);
    });
  };
  const lowLevel = server.server;
  lowLevel.onclose = () => {
    shutdown(0, "transport closed");
  };
  process.on("SIGTERM", () => {
    shutdown(0, "SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown(0, "SIGINT");
  });
}

/**
 * Await `drainBackground()` (in-flight `ship` starts finishing their
 * persistence) to COMPLETION. A timeout here was the wrong bound: a normal
 * local continuation can legitimately run past any fixed cap, and cutting it
 * kills the workflow with the process — the run cannot be resumed and its row
 * strands at `running`. A genuinely wedged drain is escaped by a second
 * shutdown signal (see installLifecycleShutdown), which is an operator
 * decision rather than a silent 10-second guess. Never throws.
 */
async function drainQuietly(shipService: ShipService, logger: Logger): Promise<void> {
  try {
    await shipService.drainBackground();
  } catch (err: unknown) {
    logger.warn({ err: errorText(err) }, "drainBackground during shutdown failed; closing anyway");
  }
}

function releaseSelf(selfEntryPath: string | undefined): void {
  if (selfEntryPath !== undefined) releaseInstance(selfEntryPath);
}

/**
 * Close the shared store, swallowing (but logging) failure. No-op when the
 * store never opened — `closeDefaultSharedStore` is a map-miss guard — so it is
 * safe on both the shutdown path and the bootstrap-failure path.
 */
function closeStoreQuietly(dbPath: string, logger: Logger): void {
  try {
    closeDefaultSharedStore(dbPath);
  } catch (err: unknown) {
    logger.warn({ err: errorText(err) }, "store close failed");
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  shipService: ShipService,
  logger: ReturnType<typeof createLogger>,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    shipService.resumeOrphanedRuns().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "periodic orphan resume sweep failed");
    });
  }, ORPHAN_RESUME_STALENESS_MS);
  timer.unref();
  return timer;
}

main().catch((err: unknown) => {
  const logger = createLogger({ stream: process.stderr });
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "mcp-server bootstrap failed");
  process.exitCode = 2;
});

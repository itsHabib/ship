// CLI-side wrapper around `@ship/core`'s `createDefaultShipService`. The
// wiring (LocalCursorRunner + node fs + sqlite store + memoizing lazy
// factory) lives in `@ship/core/src/default-wiring.ts`; the CLI just
// renames the option-bag type and re-exports the factory so existing
// call sites (`bin.ts`, tests) keep working unchanged.
//
// Path-resolution helpers (`userConfigDir`, `resolveDbPath`,
// `resolveRunsDir`) stay here — they're CLI-specific defaults and
// neither `core` nor `mcp-server` needs them.

import type { DefaultShipServiceOpts, ShipServiceFactory } from "@ship/core";
import type { DriverGhPort, DriverService } from "@ship/driver";

import { createDefaultShipService, getDefaultSharedStore } from "@ship/core";
import { createDriverService } from "@ship/driver";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { createExecGhPort } from "./gh-port.js";

// CLI's option bag — alias of `DefaultShipServiceOpts`, kept for source
// compatibility with Phase 7's `createCliService` callers.
export type CliPathOpts = DefaultShipServiceOpts;

// Memoizing factory shape — alias of `ShipServiceFactory`.
export type ServiceFactory = ShipServiceFactory;

/** Memoizing factory for `@ship/driver`'s `DriverService`. */
export type DriverServiceFactory = () => DriverService;

// Thin wrapper over `createDefaultShipService` so the CLI keeps a
// stable, CLI-named entry point. Adding CLI-only knobs here later
// (e.g. quiet-mode logging) won't ripple into the mcp-server.
export function createCliService(opts: CliPathOpts): ServiceFactory {
  return createDefaultShipService(opts);
}

/**
 * Returns a memoizing `DriverService` factory wired to the same store +
 * `ShipService` instance as `shipFactory` (mirrors the mcp-server's
 * `createMcpDriverServiceFactory` shape). Orphan resume is not enabled at
 * construction — the driver engine's `run` tick invokes the ship's
 * non-streaming `refreshOrphanedRuns` on demand, so read verbs never sweep and
 * a short-lived CLI tick keeps no lingering SDK handles.
 */
export function createCliDriverService(
  opts: CliPathOpts,
  shipFactory: ServiceFactory,
  ghPort?: DriverGhPort,
): DriverServiceFactory {
  let cached: DriverService | undefined;
  return () => {
    if (cached !== undefined) return cached;
    // Ensure ship wiring (mkdir runsDir, open store) ran first.
    const ship = shipFactory();
    const store = getDefaultSharedStore({
      dbPath: opts.dbPath,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    cached = createDriverService({
      gh: ghPort ?? createExecGhPort(),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ship,
      store,
    });
    return cached;
  };
}

/**
 * Returns the platform-specific user-config root (no `ship` suffix).
 * `resolveDbPath` / `resolveRunsDir` append the `ship` segment exactly
 * once on top of this root — see ED-2 in the Phase 7 task doc.
 *
 * POSIX honors the `XDG_CONFIG_HOME` env var per the XDG Base
 * Directory Specification; falls back to `~/.config` when unset,
 * empty, or set to a non-absolute path (the spec says relative
 * values are invalid and should be ignored). Windows reads
 * `%APPDATA%`, falling back to `~/AppData/Roaming` when the env
 * var is unset (e.g. inside a cmd.exe spawned without the user
 * environment).
 */
export function userConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData !== undefined && appData !== "") return appData;
    return join(homedir(), "AppData", "Roaming");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return xdg;
  return join(homedir(), ".config");
}

/**
 * Honor an env-var store override only when it names an absolute path.
 * A relative or empty value falls through to the caller's default — the
 * same guard the XDG lookup uses, so a bad env value never resolves a
 * cwd-relative store the caller didn't intend.
 *
 * This is why the CLI and MCP server land on the SAME store on one
 * machine: both read `SHIP_DB_PATH` / `SHIP_RUNS_DIR` first with an
 * identical `isAbsolute()` guard. A connector dispatch and a terminal
 * CLI that share the env therefore share the store instead of
 * orphaning each other's history.
 */
function envStoreOverride(name: "SHIP_DB_PATH" | "SHIP_RUNS_DIR"): string | undefined {
  const value = process.env[name];
  if (value !== undefined && value !== "" && isAbsolute(value)) return value;
  return undefined;
}

/**
 * SQLite path: absolute `SHIP_DB_PATH` override, else
 * `<UserConfigDir>/ship/state.db`. Mirrors the mcp-server's resolution
 * exactly — see `envStoreOverride`.
 */
export function resolveDbPath(): string {
  return envStoreOverride("SHIP_DB_PATH") ?? join(userConfigDir(), "ship", "state.db");
}

/**
 * Artifacts dir: absolute `SHIP_RUNS_DIR` override, else
 * `<UserConfigDir>/ship/runs/`. Mirrors the mcp-server's resolution
 * exactly — see `envStoreOverride`.
 */
export function resolveRunsDir(): string {
  return envStoreOverride("SHIP_RUNS_DIR") ?? join(userConfigDir(), "ship", "runs");
}

/**
 * CLI-side wrapper around `@ship/core`'s `createDefaultShipService`.
 * The wiring (LocalCursorRunner + node fs + sqlite store + memoizing
 * lazy factory) lives in `@ship/core/src/default-wiring.ts`; the CLI
 * just renames the option-bag type and re-exports the factory so
 * existing call sites (`bin.ts`, tests) keep working unchanged.
 *
 * Path-resolution helpers (`userConfigDir`, `resolveDbPath`,
 * `resolveRunsDir`) stay here — they're CLI-specific defaults and
 * neither `core` nor `mcp-server` needs them.
 */

import type {
  OpenPrServiceFactory as CoreOpenPrServiceFactory,
  DefaultShipServiceOpts,
  ShipServiceFactory,
} from "@ship/core";

import { createDefaultOpenPrService, createDefaultShipService } from "@ship/core";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** CLI's option bag — alias of `DefaultShipServiceOpts`, kept for source compatibility with Phase 7's `createCliService` callers. */
export type CliPathOpts = DefaultShipServiceOpts;

/** Memoizing factory shape — alias of `ShipServiceFactory`. */
export type ServiceFactory = ShipServiceFactory;

/** Re-export so commands/ files don't reach across packages directly. */
export type OpenPrServiceFactory = CoreOpenPrServiceFactory;

/**
 * Thin wrapper over `createDefaultShipService` so the CLI keeps a
 * stable, CLI-named entry point. Adding CLI-only knobs here later
 * (e.g. quiet-mode logging) won't ripple into the mcp-server.
 */
export function createCliService(opts: CliPathOpts): ServiceFactory {
  return createDefaultShipService(opts);
}

/**
 * Sibling of `createCliService` for the V2 `open_pr` capability.
 * Shares store + activeRuns with the ship factory when both are
 * constructed against the same `dbPath` (see core's default-wiring
 * § shared infra cache).
 */
export function createCliOpenPrService(opts: { dbPath: string }): OpenPrServiceFactory {
  return createDefaultOpenPrService({ dbPath: opts.dbPath });
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

/** Default SQLite path: `<UserConfigDir>/ship/state.db`. */
export function resolveDbPath(): string {
  return join(userConfigDir(), "ship", "state.db");
}

/** Default artifacts dir: `<UserConfigDir>/ship/runs/`. */
export function resolveRunsDir(): string {
  return join(userConfigDir(), "ship", "runs");
}

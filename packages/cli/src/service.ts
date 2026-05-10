/**
 * Lazy `ShipService` factory for the CLI. Production wiring:
 * `LocalCursorRunner` + `createNodeShipFs` + `createStore` glued by
 * `createShipService`. Construction is deferred until the first
 * `factory()` call so `ship --help` (and the test harness) doesn't
 * pay the disk-open cost.
 */

import type { ShipService } from "@ship/core";
import type { CursorRunner } from "@ship/cursor-runner";

import { createNodeShipFs, createShipService } from "@ship/core";
import { LocalCursorRunner } from "@ship/cursor-runner";
import { createStore } from "@ship/store";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface CliPathOpts {
  /** Absolute path to the SQLite db file, or `:memory:` for ephemeral. */
  readonly dbPath: string;
  /** Absolute path to the artifacts directory. */
  readonly runsDir: string;
  /** Default model id when `input.model` is omitted. */
  readonly defaultModelId?: string;
  /**
   * Cursor runner override. Production omits this and gets the real
   * `LocalCursorRunner`; integration tests pass a `FakeCursorRunner`
   * so they can exercise real `node:fs` + real SQLite without an API
   * key + without burning real model quota.
   */
  readonly cursor?: CursorRunner;
}

export type ServiceFactory = () => ShipService;

/**
 * Returns a memoizing factory that constructs the `ShipService` on
 * first call. Subsequent calls return the cached instance so each CLI
 * invocation gets exactly one service-store-runner-fs triple.
 */
export function createCliService(opts: CliPathOpts): ServiceFactory {
  let cached: ShipService | undefined;
  return () => {
    if (cached !== undefined) return cached;
    // First-invocation safety: create the dbPath's parent + runsDir
    // up front so SQLite + the artifact writer don't fault on a fresh
    // install. Skipped for the `:memory:` sentinel since SQLite handles
    // it in-process. See Phase 7 § Risks.
    if (opts.dbPath !== ":memory:") {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    mkdirSync(opts.runsDir, { recursive: true });
    const clock = (): string => new Date().toISOString();
    const store = createStore({ dbPath: opts.dbPath, clock });
    const cursor = opts.cursor ?? new LocalCursorRunner();
    const fs = createNodeShipFs();
    cached = createShipService({
      store,
      cursor,
      fs,
      clock,
      config: {
        runsDir: opts.runsDir,
        defaultModel: { id: opts.defaultModelId ?? "composer-2" },
      },
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

/** Default SQLite path: `<UserConfigDir>/ship/state.db`. */
export function resolveDbPath(): string {
  return join(userConfigDir(), "ship", "state.db");
}

/** Default artifacts dir: `<UserConfigDir>/ship/runs/`. */
export function resolveRunsDir(): string {
  return join(userConfigDir(), "ship", "runs");
}

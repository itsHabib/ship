/**
 * mcp-server store-path resolution — the agent-facing mirror of the CLI's
 * `@ship/cli/src/service.ts` resolvers.
 *
 * Both surfaces read `SHIP_DB_PATH` / `SHIP_RUNS_DIR` FIRST, guarded by
 * `isAbsolute()`, then fall back to `<UserConfigDir>/ship/{state.db, runs/}`.
 * Keeping the resolution here (rather than inline in `bin.ts`) makes it
 * unit-testable without booting the stdio entrypoint, so an L1 parity matrix
 * can pin CLI == mcp-server resolution across the full env grid.
 *
 * The CLI's helpers are intentionally NOT imported — that would invert the
 * mcp-server → cli dep direction (see `test/dep-direction.test.ts`). We
 * re-derive the identical XDG / APPDATA lookup and `isAbsolute()` guard here;
 * the parity test is what keeps the two copies honest.
 *
 * This is why a connector dispatch (MCP server) and a terminal `ship` run
 * (CLI) on ONE machine land on the SAME store instead of orphaning each
 * other's history: same env, same guard, same resolved paths.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Honor a store env override only when it names an absolute path. A relative
 * or empty value falls through to the default so a bad env value never
 * resolves a cwd-relative store the caller didn't intend.
 */
function envStoreOverride(name: "SHIP_DB_PATH" | "SHIP_RUNS_DIR"): string | undefined {
  const value = process.env[name];
  if (value !== undefined && value !== "" && isAbsolute(value)) return value;
  return undefined;
}

/**
 * Platform-specific user-config root (no `ship` suffix). POSIX honors
 * `XDG_CONFIG_HOME` only when absolute (per the XDG spec); Windows reads
 * `%APPDATA%`, falling back to `~/AppData/Roaming` when unset. Mirrors
 * `@ship/cli/src/service.ts#userConfigDir`.
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
 * SQLite path: absolute `SHIP_DB_PATH` override, else
 * `<UserConfigDir>/ship/state.db`. Mirrors `@ship/cli`'s `resolveDbPath`.
 */
export function resolveDbPath(): string {
  return envStoreOverride("SHIP_DB_PATH") ?? join(userConfigDir(), "ship", "state.db");
}

/**
 * Artifacts dir: absolute `SHIP_RUNS_DIR` override, else
 * `<UserConfigDir>/ship/runs/`. Mirrors `@ship/cli`'s `resolveRunsDir`.
 */
export function resolveRunsDir(): string {
  return envStoreOverride("SHIP_RUNS_DIR") ?? join(userConfigDir(), "ship", "runs");
}

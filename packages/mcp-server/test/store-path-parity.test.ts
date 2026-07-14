/**
 * L1 store-path parity matrix — the CLI and the MCP server MUST resolve
 * `SHIP_DB_PATH` / `SHIP_RUNS_DIR` to identical paths, and reject
 * relative / empty values identically, so two seats on ONE machine
 * (a connector dispatch via the MCP server, a terminal `ship` via the
 * CLI) land on the SAME store instead of orphaning each other's history.
 *
 * This is a `test/**` file precisely so it can import `@ship/cli`
 * alongside the mcp-server's own resolvers: the dep-direction guard only
 * forbids `src/**` from importing the sibling consumer (it re-derives
 * the shape, never imports it), and this cross-surface assertion is what
 * keeps the two independent copies honest.
 *
 * Matrix: (env set-absolute | unset | empty | relative) × (dbPath | runsDir)
 * × (CLI | mcp-server), plus the platform axis (posix | win32) for the
 * default-fallback branch.
 */

// Import the CLI resolvers by their source subpath, NOT the package main
// (`@ship/cli` → `src/bin.ts`, whose top-level `main()` would boot the CLI on
// import). The dep-direction guard only scans `src/**`, so a `test/**`
// cross-surface import is sanctioned.
import {
  resolveDbPath as cliResolveDbPath,
  resolveRunsDir as cliResolveRunsDir,
} from "@ship/cli/src/service.js";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  resolveDbPath as mcpResolveDbPath,
  resolveRunsDir as mcpResolveRunsDir,
} from "../src/store-paths.js";

interface Surface {
  name: string;
  resolveDbPath: () => string;
  resolveRunsDir: () => string;
}

const SURFACES: Surface[] = [
  { name: "CLI", resolveDbPath: cliResolveDbPath, resolveRunsDir: cliResolveRunsDir },
  { name: "mcp-server", resolveDbPath: mcpResolveDbPath, resolveRunsDir: mcpResolveRunsDir },
];

// `vi.stubEnv` restores every mutated env var on `unstubAllEnvs` (stubbing
// `undefined` deletes it) — no dynamic `delete process.env[...]`. Platform is
// not env, so it snapshots / restores separately.
const origPlatform = process.platform;

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: origPlatform });
});

function setPosix(): void {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.stubEnv("XDG_CONFIG_HOME", "/abs/xdg");
  vi.stubEnv("SHIP_DB_PATH", "");
  vi.stubEnv("SHIP_RUNS_DIR", "");
}

describe("store-path parity: same env → same paths on both surfaces", () => {
  test("absolute SHIP_DB_PATH / SHIP_RUNS_DIR win identically", () => {
    setPosix();
    vi.stubEnv("SHIP_DB_PATH", "/abs/store/state.db");
    vi.stubEnv("SHIP_RUNS_DIR", "/abs/store/runs");
    for (const surface of SURFACES) {
      expect(surface.resolveDbPath(), surface.name).toBe("/abs/store/state.db");
      expect(surface.resolveRunsDir(), surface.name).toBe("/abs/store/runs");
    }
    expect(SURFACES[0]?.resolveDbPath()).toBe(SURFACES[1]?.resolveDbPath());
    expect(SURFACES[0]?.resolveRunsDir()).toBe(SURFACES[1]?.resolveRunsDir());
  });

  test("unset env falls back to the same <XDG>/ship default on both", () => {
    setPosix();
    for (const surface of SURFACES) {
      expect(surface.resolveDbPath(), surface.name).toBe(join("/abs/xdg", "ship", "state.db"));
      expect(surface.resolveRunsDir(), surface.name).toBe(join("/abs/xdg", "ship", "runs"));
    }
  });
});

describe("store-path parity: relative / invalid env rejected identically", () => {
  const rejected: { label: string; value: string }[] = [
    { label: "relative", value: "relative/store/state.db" },
    { label: "dot-relative", value: "./store" },
    { label: "empty", value: "" },
  ];

  for (const { label, value } of rejected) {
    test(`a ${label} SHIP_DB_PATH is ignored — both fall back to the default`, () => {
      setPosix();
      vi.stubEnv("SHIP_DB_PATH", value);
      for (const surface of SURFACES) {
        expect(surface.resolveDbPath(), surface.name).toBe(join("/abs/xdg", "ship", "state.db"));
        expect(surface.resolveDbPath(), surface.name).not.toBe(value);
      }
      expect(SURFACES[0]?.resolveDbPath()).toBe(SURFACES[1]?.resolveDbPath());
    });

    test(`a ${label} SHIP_RUNS_DIR is ignored — both fall back to the default`, () => {
      setPosix();
      vi.stubEnv("SHIP_RUNS_DIR", value);
      for (const surface of SURFACES) {
        expect(surface.resolveRunsDir(), surface.name).toBe(join("/abs/xdg", "ship", "runs"));
        expect(surface.resolveRunsDir(), surface.name).not.toBe(value);
      }
      expect(SURFACES[0]?.resolveRunsDir()).toBe(SURFACES[1]?.resolveRunsDir());
    });
  }
});

describe("store-path parity: default-fallback platform branches match", () => {
  test("posix without XDG uses ~/.config on both, identically", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("SHIP_DB_PATH", "");
    vi.stubEnv("SHIP_RUNS_DIR", "");
    expect(SURFACES[0]?.resolveDbPath()).toBe(SURFACES[1]?.resolveDbPath());
    expect(SURFACES[0]?.resolveRunsDir()).toBe(SURFACES[1]?.resolveRunsDir());
    for (const surface of SURFACES) {
      expect(surface.resolveDbPath(), surface.name).toMatch(
        /[\\/]\.config[\\/]ship[\\/]state\.db$/,
      );
      expect(surface.resolveRunsDir(), surface.name).toMatch(/[\\/]\.config[\\/]ship[\\/]runs$/);
    }
  });

  test("win32 uses APPDATA on both, identically", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("APPDATA", "C:\\Users\\dev\\AppData\\Roaming");
    vi.stubEnv("SHIP_DB_PATH", "");
    vi.stubEnv("SHIP_RUNS_DIR", "");
    expect(SURFACES[0]?.resolveDbPath()).toBe(SURFACES[1]?.resolveDbPath());
    expect(SURFACES[0]?.resolveRunsDir()).toBe(SURFACES[1]?.resolveRunsDir());
    for (const surface of SURFACES) {
      expect(surface.resolveDbPath(), surface.name).toContain("AppData");
    }
  });
});

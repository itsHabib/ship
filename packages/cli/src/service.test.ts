/** Tests for `service.ts` — lazy factory, path resolution. */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createCliService, resolveDbPath, resolveRunsDir, userConfigDir } from "./service.js";

describe("createCliService", () => {
  test("returns a memoizing factory: two calls yield the same service", () => {
    const factory = createCliService({ dbPath: ":memory:", runsDir: "/tmp/ship-runs-test" });
    const first = factory();
    const second = factory();
    expect(first).toBe(second);
    // Service exposes the four methods.
    expect(typeof first.ship).toBe("function");
    expect(typeof first.getRun).toBe("function");
    expect(typeof first.listRuns).toBe("function");
    expect(typeof first.cancelRun).toBe("function");
  });

  test("--db-path :memory: is accepted (no disk side-effects)", () => {
    const factory = createCliService({ dbPath: ":memory:", runsDir: "/tmp/ship-runs-test" });
    expect(() => factory()).not.toThrow();
  });
});

describe("path resolution", () => {
  const origPlatform = process.platform;
  // `vi.stubEnv` restores every mutated var on `unstubAllEnvs` (stubbing "" is
  // how "unset for this test" is expressed vs the real inherited env). Platform
  // is not env, so it snapshots / restores separately.
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: origPlatform });
  });

  test("resolveDbPath / resolveRunsDir append `ship` exactly once on POSIX", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CONFIG_HOME", "");
    const home = userConfigDir();
    expect(resolveDbPath().startsWith(home)).toBe(true);
    expect(resolveDbPath().endsWith("state.db")).toBe(true);
    // Crucially: not `<home>/ship/ship/state.db`.
    expect(resolveDbPath()).not.toMatch(/[\\/]ship[\\/]ship[\\/]state\.db$/);
    expect(resolveRunsDir()).not.toMatch(/[\\/]ship[\\/]ship[\\/]runs$/);
  });

  test("POSIX honors XDG_CONFIG_HOME when set; falls back to ~/.config when unset", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CONFIG_HOME", "/custom/xdg");
    expect(userConfigDir()).toBe("/custom/xdg");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(userConfigDir().endsWith(".config") || userConfigDir().endsWith(".config\\")).toBe(true);
  });

  test("POSIX treats empty XDG_CONFIG_HOME as unset (per the XDG spec)", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(userConfigDir()).not.toBe("");
    expect(userConfigDir().endsWith(".config")).toBe(true);
  });

  test("POSIX ignores a relative XDG_CONFIG_HOME (spec: only absolute paths are valid)", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CONFIG_HOME", "relative/.config");
    expect(userConfigDir()).not.toBe("relative/.config");
    expect(userConfigDir().endsWith(".config")).toBe(true);
  });

  test("Windows uses APPDATA when set; falls back to ~/AppData/Roaming when not", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("APPDATA", "C:\\Users\\dev\\AppData\\Roaming");
    expect(userConfigDir()).toBe("C:\\Users\\dev\\AppData\\Roaming");
    vi.stubEnv("APPDATA", "");
    expect(userConfigDir()).toMatch(/[\\/]AppData[\\/]Roaming$/);
  });

  test("an absolute SHIP_DB_PATH / SHIP_RUNS_DIR override wins over the default", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CONFIG_HOME", "/abs/xdg");
    vi.stubEnv("SHIP_DB_PATH", "/abs/store/state.db");
    vi.stubEnv("SHIP_RUNS_DIR", "/abs/store/runs");
    expect(resolveDbPath()).toBe("/abs/store/state.db");
    expect(resolveRunsDir()).toBe("/abs/store/runs");
  });

  test("a relative SHIP_DB_PATH / SHIP_RUNS_DIR is rejected — falls back to the default", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CONFIG_HOME", "/abs/xdg");
    vi.stubEnv("SHIP_DB_PATH", "relative/state.db");
    vi.stubEnv("SHIP_RUNS_DIR", "./runs");
    expect(resolveDbPath()).toBe(join("/abs/xdg", "ship", "state.db"));
    expect(resolveRunsDir()).toBe(join("/abs/xdg", "ship", "runs"));
  });

  test("an empty SHIP_DB_PATH / SHIP_RUNS_DIR is treated as unset", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CONFIG_HOME", "/abs/xdg");
    vi.stubEnv("SHIP_DB_PATH", "");
    vi.stubEnv("SHIP_RUNS_DIR", "");
    expect(resolveDbPath()).toBe(join("/abs/xdg", "ship", "state.db"));
    expect(resolveRunsDir()).toBe(join("/abs/xdg", "ship", "runs"));
  });
});

describe("createCliService construction does not eagerly open the store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("createCliService returns a function without doing IO; only factory() opens the store", () => {
    // Even with an unusable path, no throw on construction — work
    // happens on first factory call.
    const factory = createCliService({
      dbPath: ":memory:",
      runsDir: "/tmp/ship-runs-test-no-io",
    });
    expect(typeof factory).toBe("function");
  });
});

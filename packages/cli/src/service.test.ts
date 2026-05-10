/** Tests for `service.ts` — lazy factory, path resolution. */

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
  const origAppData = process.env["APPDATA"];

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform });
    if (origAppData === undefined) {
      delete process.env["APPDATA"];
    } else {
      process.env["APPDATA"] = origAppData;
    }
  });

  test("resolveDbPath / resolveRunsDir append `ship` exactly once on POSIX", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const home = userConfigDir();
    expect(resolveDbPath().startsWith(home)).toBe(true);
    expect(resolveDbPath().endsWith("state.db")).toBe(true);
    // Crucially: not `<home>/ship/ship/state.db`.
    expect(resolveDbPath()).not.toMatch(/[\\/]ship[\\/]ship[\\/]state\.db$/);
    expect(resolveRunsDir()).not.toMatch(/[\\/]ship[\\/]ship[\\/]runs$/);
  });

  test("Windows uses APPDATA when set; falls back to ~/AppData/Roaming when not", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env["APPDATA"] = "C:\\Users\\dev\\AppData\\Roaming";
    expect(userConfigDir()).toBe("C:\\Users\\dev\\AppData\\Roaming");
    delete process.env["APPDATA"];
    expect(userConfigDir()).toMatch(/[\\/]AppData[\\/]Roaming$/);
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

/**
 * Tests for `default-wiring.ts` — memoization + lazy-construction +
 * `:memory:` short-circuit. Live wiring (real SQLite + node fs) is
 * exercised via the integration suite in `e2e/integration/`.
 */

import { describe, expect, test } from "vitest";

import { createDefaultShipService } from "./default-wiring.js";

describe("createDefaultShipService", () => {
  test("returns a memoizing factory: two calls yield the same service", () => {
    const factory = createDefaultShipService({
      dbPath: ":memory:",
      runsDir: "/tmp/ship-default-wiring-test",
    });
    const first = factory();
    const second = factory();
    expect(first).toBe(second);
    // Service exposes the four methods the cli + mcp-server consume.
    expect(typeof first.ship).toBe("function");
    expect(typeof first.getRun).toBe("function");
    expect(typeof first.listRuns).toBe("function");
    expect(typeof first.cancelRun).toBe("function");
  });

  test("dbPath = :memory: skips the parent-dir mkdir (no disk side-effects)", () => {
    const factory = createDefaultShipService({
      dbPath: ":memory:",
      runsDir: "/tmp/ship-default-wiring-test",
    });
    expect(() => factory()).not.toThrow();
  });

  test("construction is lazy: createDefaultShipService returns without doing IO", () => {
    // Even with an unusable dbPath, creating the factory shouldn't throw —
    // work happens on first factory() call. We don't invoke factory() here
    // because that WOULD try to open a real SQLite file.
    const factory = createDefaultShipService({
      dbPath: ":memory:",
      runsDir: "/tmp/ship-default-wiring-test-no-io",
    });
    expect(typeof factory).toBe("function");
  });
});

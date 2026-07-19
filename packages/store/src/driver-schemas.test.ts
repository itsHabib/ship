/** Tests for driver stream schema invariants. */

import { describe, expect, it } from "vitest";

import { driverStreamSchema } from "./driver-schemas.js";

const baseStream = {
  attempts: [],
  createdAt: "2026-07-18T00:00:00Z",
  driverBatchId: "batch-1",
  driverRunId: "run-1",
  id: "stream-1",
  runtime: "cloud",
  specPath: "docs/a.md",
  status: "pending",
  streamIndex: 0,
  touches: [],
  updatedAt: "2026-07-18T00:00:00Z",
};

const fallbackTrio = {
  fallbackChain: [{ provider: "claude", runtime: "local" }],
  fallbackCursor: 0,
  fallbackLog: [],
};

describe("driverStreamSchema fallback trio", () => {
  it("accepts a stream with no fallback fields", () => {
    expect(driverStreamSchema.safeParse(baseStream).success).toBe(true);
  });

  it("accepts the full trio", () => {
    expect(driverStreamSchema.safeParse({ ...baseStream, ...fallbackTrio }).success).toBe(true);
  });

  it("rejects a partially-populated trio", () => {
    for (const key of ["fallbackChain", "fallbackCursor", "fallbackLog"] as const) {
      const partial = { ...baseStream, [key]: fallbackTrio[key] };
      const result = driverStreamSchema.safeParse(partial);
      expect(result.success).toBe(false);
    }
  });
});

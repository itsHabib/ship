import { describe, expect, it } from "vitest";

import type { Receipt } from "./schema.js";

import { formatReport, report } from "./report.js";
import { buildReceipt } from "./schema.js";

function mixed(): Receipt[] {
  return [
    buildReceipt({
      key: "d1",
      source: "driver",
      outcome: "merged",
      cycles: 2,
      cycles_capped: false,
      runtime: "local",
    }),
    buildReceipt({
      key: "d2",
      source: "driver",
      outcome: "failed",
      cycles: 4,
      cycles_capped: true,
      runtime: "cloud",
    }),
    buildReceipt({ key: "d3", source: "driver", outcome: "pending" }),
    buildReceipt({
      key: "r1",
      source: "ship-run",
      outcome: "succeeded",
      ship_status: "succeeded",
      duration_ms: 100,
      model: "composer-2",
    }),
    buildReceipt({
      key: "r2",
      source: "ship-run",
      outcome: "succeeded",
      ship_status: "succeeded",
      duration_ms: 200,
      model: "composer-2",
    }),
    buildReceipt({
      key: "r3",
      source: "ship-run",
      outcome: "failed",
      ship_status: "failed",
      duration_ms: 300,
    }),
  ];
}

describe("report", () => {
  const summary = report(mixed());

  it("segments counts by source and tallies outcomes", () => {
    expect(summary.total).toBe(6);
    expect(summary.bySource).toEqual({ driver: 3, "ship-run": 3 });
    expect(summary.byOutcome).toEqual({ merged: 1, failed: 2, pending: 1, succeeded: 2 });
  });

  it("computes driver merge rate, cycle stats, capped count, and runtime split", () => {
    expect(summary.driver.merged).toBe(1);
    expect(summary.driver.mergeRate).toBeCloseTo(1 / 3);
    expect(summary.driver.cyclesMean).toBe(3);
    expect(summary.driver.cyclesMedian).toBe(3);
    expect(summary.driver.cyclesMax).toBe(4);
    expect(summary.driver.cappedCount).toBe(1);
    expect(summary.driver.byRuntime).toEqual({ local: 1, cloud: 1, unknown: 1 });
  });

  it("computes ship-run success rate, duration percentiles, and model split", () => {
    expect(summary.shipRun.succeeded).toBe(2);
    expect(summary.shipRun.failed).toBe(1);
    expect(summary.shipRun.successRate).toBeCloseTo(2 / 3);
    expect(summary.shipRun.durationMedianMs).toBe(200);
    expect(summary.shipRun.durationP90Ms).toBe(280);
    expect(summary.shipRun.byModel).toEqual({ "composer-2": 2, unknown: 1 });
  });

  it("yields null rates and an empty tally for no receipts", () => {
    const empty = report([]);
    expect(empty.total).toBe(0);
    expect(empty.driver.mergeRate).toBeNull();
    expect(empty.driver.cyclesMax).toBeNull();
    expect(empty.shipRun.successRate).toBeNull();
    expect(empty.shipRun.durationMedianMs).toBeNull();
    expect(empty.byOutcome).toEqual({});
  });
});

describe("formatReport", () => {
  it("renders populated metrics as percentages and counts", () => {
    const text = formatReport(report(mixed()));
    expect(text).toContain("run receipts: 6 (driver 3, ship-run 3)");
    expect(text).toContain("merged 1/3 (33%)");
    expect(text).toContain("succeeded 2/3 (67%)");
    expect(text).toContain("median 200");
  });

  it("renders n/a for empty metrics", () => {
    const text = formatReport(report([]));
    expect(text).toContain("(n/a)");
    expect(text).toContain("runtime: none");
  });
});

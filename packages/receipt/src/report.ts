/**
 * The query layer: receipts → headline metrics, segmented by source.
 *
 * Segmentation is deliberate. Driver rows know merge rate and review cycles;
 * ship-run rows know duration and model. Reporting them apart keeps a metric
 * from silently averaging a column one source never fills (e.g. there is no
 * "merge rate" over ship runs). Everything here is pure.
 */

import type { Receipt, ReceiptSource } from "./schema.js";

export interface DriverMetrics {
  total: number;
  merged: number;
  mergeRate: number | null;
  cyclesMean: number | null;
  cyclesMedian: number | null;
  cyclesMax: number | null;
  cappedCount: number;
  byRuntime: Record<string, number>;
}

export interface ShipRunMetrics {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number | null;
  durationMedianMs: number | null;
  durationP90Ms: number | null;
  byModel: Record<string, number>;
}

export interface ReportSummary {
  total: number;
  bySource: Record<ReceiptSource, number>;
  byOutcome: Record<string, number>;
  driver: DriverMetrics;
  shipRun: ShipRunMetrics;
}

export function report(receipts: Receipt[]): ReportSummary {
  const driver = receipts.filter((receipt) => receipt.source === "driver");
  const runs = receipts.filter((receipt) => receipt.source === "ship-run");
  return {
    total: receipts.length,
    bySource: { driver: driver.length, "ship-run": runs.length },
    byOutcome: tally(receipts.map((receipt) => receipt.outcome)),
    driver: driverMetrics(driver),
    shipRun: shipRunMetrics(runs),
  };
}

function driverMetrics(driver: Receipt[]): DriverMetrics {
  const merged = driver.filter((receipt) => receipt.outcome === "merged").length;
  const cycles = definedNumbers(driver.map((receipt) => receipt.cycles));
  return {
    total: driver.length,
    merged,
    mergeRate: ratio(merged, driver.length),
    cyclesMean: mean(cycles),
    cyclesMedian: percentile(cycles, 50),
    cyclesMax: cycles.length === 0 ? null : Math.max(...cycles),
    cappedCount: driver.filter((receipt) => receipt.cycles_capped === true).length,
    byRuntime: tally(driver.map((receipt) => receipt.runtime)),
  };
}

function shipRunMetrics(runs: Receipt[]): ShipRunMetrics {
  const succeeded = countStatus(runs, "succeeded");
  const durations = definedNumbers(runs.map((receipt) => receipt.duration_ms));
  return {
    total: runs.length,
    succeeded,
    failed: countStatus(runs, "failed"),
    cancelled: countStatus(runs, "cancelled"),
    successRate: ratio(succeeded, runs.length),
    durationMedianMs: roundOrNull(percentile(durations, 50)),
    durationP90Ms: roundOrNull(percentile(durations, 90)),
    byModel: tally(runs.map((receipt) => receipt.model)),
  };
}

/** Render a `ReportSummary` as a compact, human-scannable text block. */
export function formatReport(summary: ReportSummary): string {
  const lines = [
    `run receipts: ${String(summary.total)} (driver ${String(summary.bySource.driver)}, ship-run ${String(summary.bySource["ship-run"])})`,
    `outcomes: ${formatCounts(summary.byOutcome)}`,
    "",
    "driver (loop outcomes):",
    `  merged ${String(summary.driver.merged)}/${String(summary.driver.total)} (${formatRate(summary.driver.mergeRate)})`,
    `  review cycles: mean ${formatNum(summary.driver.cyclesMean)}, median ${formatNum(summary.driver.cyclesMedian)}, max ${formatNum(summary.driver.cyclesMax)}, capped(>=3) ${String(summary.driver.cappedCount)}`,
    `  runtime: ${formatCounts(summary.driver.byRuntime)}`,
    "",
    "ship-run (execution):",
    `  succeeded ${String(summary.shipRun.succeeded)}/${String(summary.shipRun.total)} (${formatRate(summary.shipRun.successRate)}), failed ${String(summary.shipRun.failed)}, cancelled ${String(summary.shipRun.cancelled)}`,
    `  duration ms: median ${formatNum(summary.shipRun.durationMedianMs)}, p90 ${formatNum(summary.shipRun.durationP90Ms)}`,
    `  model: ${formatCounts(summary.shipRun.byModel)}`,
  ];
  return lines.join("\n");
}

function countStatus(runs: Receipt[], status: string): number {
  return runs.filter((receipt) => receipt.ship_status === status).length;
}

function definedNumbers(values: (number | undefined)[]): number[] {
  return values.filter((value): value is number => value !== undefined);
}

function tally(values: (string | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function ratio(part: number, whole: number): number | null {
  if (whole === 0) {
    return null;
  }
  return part / whole;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (pct / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (rank - low);
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return "none";
  }
  const sorted = [...entries].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  return sorted.map(([key, count]) => `${key} ${String(count)}`).join(", ");
}

function formatRate(rate: number | null): string {
  if (rate === null) {
    return "n/a";
  }
  return `${String(Math.round(rate * 100))}%`;
}

function formatNum(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return String(Math.round(value * 100) / 100);
}

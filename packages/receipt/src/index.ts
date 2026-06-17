/**
 * `@ship/receipt` — the workbench run-receipt layer.
 *
 * One receipt = one unit of agent work joined from the structured artifacts the
 * loop already emits (work-driver manifests + ship run dirs), persisted as an
 * append-safe JSONL dataset, and queryable into headline metrics. The CLI lives
 * in `bin.ts`; this barrel is the programmatic surface.
 */

export type { Receipt, ReceiptOutcome, ReceiptRuntime, ReceiptSource } from "./schema.js";
export { buildReceipt, RECEIPT_SCHEMA_VERSION, receiptIdentity, receiptSchema } from "./schema.js";

export { CYCLE_CAP, manifestToReceipts } from "./manifest.js";
export {
  loadShipRunReceipts,
  prNumberFromUrl,
  resolveDefaultRunsDir,
  runResultToReceipt,
} from "./runs.js";
export { sortReceipts, upsertReceipts } from "./build.js";

export type { DriverMetrics, ReportSummary, ShipRunMetrics } from "./report.js";
export { formatReport, report } from "./report.js";

export {
  parseReceiptsJsonl,
  readReceiptsFile,
  serializeReceiptsJsonl,
  writeReceiptsFile,
} from "./jsonl.js";

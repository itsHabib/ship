/**
 * Global test safety net: never let a test write park receipts to the operator's
 * REAL ship data-dir file.
 *
 * The driver now resolves park receipts to the canonical
 * `<config>/ship/receipts.jsonl` (see `resolveDefaultReceiptsPath`), which flare
 * tails to page a phone. Any test that drives a run to `awaiting_judgment` would
 * otherwise inject fake `parked` rows into that real file and page the operator.
 *
 * This setup (wired into every relevant package's `vitest.config.ts`
 * `test.setupFiles`, and the root config) redirects `SHIP_RECEIPTS_PATH` to a
 * unique per-worker temp file when the env var is unset — so the real file is
 * untouched regardless of which test parks. A test that asserts on receipt
 * *contents* still sets its own `SHIP_RECEIPTS_PATH` per-test (which we respect,
 * since we only fill in an unset value) for a fresh, deterministic file.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env["SHIP_RECEIPTS_PATH"] === undefined || process.env["SHIP_RECEIPTS_PATH"] === "") {
  const dir = mkdtempSync(join(tmpdir(), "ship-receipts-isolation-"));
  process.env["SHIP_RECEIPTS_PATH"] = join(dir, "receipts.jsonl");
}

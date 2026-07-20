/**
 * Global test safety net: never let a test write driver-state ledger events to
 * the operator's REAL `~/.workbench/driver-state` root.
 *
 * `createDriverService` wraps its store with best-effort ledger emission
 * (see `@ship/driver`'s driverstate-emit.ts), so any test that imports a
 * manifest or patches a stream through the service would otherwise append
 * events to the real canonical record that /wip and /shipped read.
 *
 * Mirrors receipts-isolation.ts: redirect `WORKBENCH_STATE_DIR` to a unique
 * per-worker temp dir when unset — tests that assert on ledger contents set
 * their own value per-test, which we respect.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env["WORKBENCH_STATE_DIR"] === undefined || process.env["WORKBENCH_STATE_DIR"] === "") {
  process.env["WORKBENCH_STATE_DIR"] = mkdtempSync(join(tmpdir(), "driverstate-isolation-"));
}

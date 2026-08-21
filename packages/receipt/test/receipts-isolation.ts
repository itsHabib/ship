/**
 * Global test safety net: never let a test write park receipts to the operator's
 * REAL ship data-dir file.
 *
 * The driver resolves park receipts to the canonical
 * `<config>/ship/receipts.jsonl` (see `resolveDefaultReceiptsPath`), which flare
 * tails to page a phone. Any test that drives a run to `awaiting_judgment` would
 * otherwise inject fake `parked` rows into that real file and page the operator.
 *
 * This setup is wired into every relevant package's `vitest.config.ts`
 * `test.setupFiles`, the root config, and the e2e config.
 *
 * UNCONDITIONAL by design. This originally filled in only an *unset*
 * `SHIP_RECEIPTS_PATH`, so any environment that exported the var at the real
 * canonical file — a developer or CI box — silently defeated the safety net and
 * `make integration` could append synthetic parked receipts to the file flare
 * tails (#251 review, Codex P1; same hole was fixed in driverstate-isolation.ts).
 * Setup files run before any test body, so a test that asserts on receipt
 * *contents* still pins its own `SHIP_RECEIPTS_PATH` in a `beforeEach`;
 * `@ship/driver`'s engine tests do exactly that.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ship-receipts-isolation-"));
process.env["SHIP_RECEIPTS_PATH"] = join(dir, "receipts.jsonl");

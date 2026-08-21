/**
 * Global test safety net: never let a test write driver-state ledger events to
 * the operator's REAL `~/.workbench/driver-state` root.
 *
 * `createDriverService` wraps its store with best-effort ledger emission
 * (see `@ship/driver`'s driverstate-emit.ts), so any test that imports a
 * manifest or patches a stream through the service would otherwise append
 * events to the real canonical record that /wip and /shipped read.
 *
 * Wired into every `vitest.config.ts` in the repo — enforced by
 * `isolation-wiring.test.ts`, because the one config that omitted it put 235
 * fixture runs into the operator's store.
 *
 * UNCONDITIONAL by design. This originally mirrored receipts-isolation.ts and
 * only filled in an *unset* `WORKBENCH_STATE_DIR`, which meant any environment
 * that exported the var — a developer or CI box pointing at a real canonical
 * store — silently defeated the entire safety net (#251 review, Codex P1).
 * Setup files run before any test body, so a test that needs a specific root
 * still overrides this in its own `beforeEach`; several in `@ship/driver` do.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["WORKBENCH_STATE_DIR"] = mkdtempSync(join(tmpdir(), "driverstate-isolation-"));

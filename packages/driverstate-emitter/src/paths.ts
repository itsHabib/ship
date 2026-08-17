/**
 * State-root path resolution. Mirrors workbench's default: `WORKBENCH_STATE_DIR`
 * env when set, else `~/.workbench/driver-state`. Callers (tests, ship's
 * engine under a custom sandbox) can also pass an explicit root straight to
 * `appendEvent`, bypassing both.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The operator's real store: `~/.workbench/driver-state`. */
export function defaultStateRoot(): string {
  return join(homedir(), ".workbench", "driver-state");
}

export function resolveStateRoot(): string {
  const fromEnv = process.env["WORKBENCH_STATE_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  assertNotDefaultRootUnderTest();
  return defaultStateRoot();
}

/**
 * Regression guard: under vitest, falling through to the real
 * `~/.workbench/driver-state` means a `vitest.config.ts` forgot to wire
 * `test/driverstate-isolation.ts` into `setupFiles`. Fail loudly rather than
 * silently appending fixture runs to the operator's canonical record — that
 * happened once already, burying 1 real run under 235 fakes that `/wip`,
 * `driver_runs`, and `driver_rollup` all read as genuine work.
 *
 * `isolation-wiring.test.ts` asserts every config wires the setup file, so this
 * is the second line of defence, not the first.
 */
function assertNotDefaultRootUnderTest(): void {
  if (process.env["VITEST"] === undefined) {
    return;
  }
  throw new Error(
    "driverstate: refusing to resolve the real store " +
      `(${defaultStateRoot()}) under vitest. WORKBENCH_STATE_DIR is unset, ` +
      "which means this suite's vitest.config.ts is missing " +
      '"driverstate-emitter/test/driverstate-isolation.ts" in test.setupFiles. ' +
      "Add it, or set WORKBENCH_STATE_DIR to a temp dir for this test.",
  );
}

export function runDir(stateRoot: string, runId: string): string {
  return join(stateRoot, runId);
}

export function ledgerPath(rd: string): string {
  return join(rd, "events.jsonl");
}

export function leasePath(rd: string): string {
  return join(rd, "lease.json");
}

export function appendLockPath(rd: string): string {
  return join(rd, "append.lock");
}

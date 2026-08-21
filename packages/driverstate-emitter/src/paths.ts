/**
 * State-root path resolution. Mirrors workbench's default: `WORKBENCH_STATE_DIR`
 * env when set, else `~/.workbench/driver-state`. Callers (tests, ship's
 * engine under a custom sandbox) can also pass an explicit root straight to
 * `appendEvent`, bypassing both.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The operator's real store: `~/.workbench/driver-state`. */
export function defaultStateRoot(): string {
  return join(homedir(), ".workbench", "driver-state");
}

export function resolveStateRoot(): string {
  const root = stateRootFromEnvOrDefault();
  assertNotDefaultRootUnderTest(root);
  return root;
}

function stateRootFromEnvOrDefault(): string {
  const fromEnv = process.env["WORKBENCH_STATE_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return defaultStateRoot();
}

/**
 * Regression guard: under vitest, no suite may resolve the operator's real
 * `~/.workbench/driver-state`. Fail loudly rather than silently appending
 * fixture runs to the canonical record — that happened once already, burying 1
 * real run under 235 fakes that `/wip`, `driver_runs`, and `driver_rollup` all
 * read as genuine work.
 *
 * Checks the RESOLVED root, not just the unset case: an environment that
 * exports `WORKBENCH_STATE_DIR` at the real store would otherwise sail past
 * both this and the isolation setup file (#251 review, Codex P1).
 *
 * `isolation-wiring.test.ts` asserts every config wires the setup file, so this
 * is the second line of defence, not the first.
 */
function assertNotDefaultRootUnderTest(root: string): void {
  if (process.env["VITEST"] === undefined) {
    return;
  }
  if (resolve(root) !== resolve(defaultStateRoot())) {
    return;
  }
  const why =
    process.env["WORKBENCH_STATE_DIR"] === undefined || process.env["WORKBENCH_STATE_DIR"] === ""
      ? "WORKBENCH_STATE_DIR is unset, so this suite's vitest.config.ts does not wire"
      : "WORKBENCH_STATE_DIR points at it; every suite must instead wire";
  throw new Error(
    `driverstate: refusing to resolve the operator's real store (${defaultStateRoot()}) ` +
      `under vitest. ${why} ` +
      "packages/driverstate-emitter/test/driverstate-isolation.ts into " +
      "test.setupFiles (as a path relative to that config). Add it, or point " +
      "WORKBENCH_STATE_DIR at a temp dir for this test.",
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

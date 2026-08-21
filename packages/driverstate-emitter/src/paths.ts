/**
 * State-root path resolution. Mirrors workbench's default: `WORKBENCH_STATE_DIR`
 * env when set, else `~/.workbench/driver-state`. Callers (tests, ship's
 * engine under a custom sandbox) can also pass an explicit root straight to
 * `appendEvent`, bypassing both.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

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
  if (canonical(root) !== canonical(defaultStateRoot())) {
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

/**
 * Filesystem identity of a path, for guard comparisons. `resolve()` alone
 * neither dereferences symlinks nor case-folds, so a `WORKBENCH_STATE_DIR`
 * naming the real store through a symlink alias (or different casing on
 * Windows) would compare unequal and slip past the guard — the same gap
 * closed in `@ship/receipt`'s runs.ts (#252 review, Codex/Claude P2). A leaf
 * that does not exist yet — the usual state before the first write this guard
 * exists to block — canonicalizes its parent and reattaches the basename, so
 * a symlinked ancestor is still dereferenced (#252 review round 1, full
 * panel); only when the parent is absent too does the lexical resolution
 * stand. Mirrors `canonicalStorePath` in mcp-server's single-instance.ts.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return canonicalViaParent(path);
  }
}

function canonicalViaParent(path: string): string {
  try {
    return realpathSync(dirname(path)) + sep + basename(path);
  } catch {
    return resolve(path);
  }
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

/**
 * State-root path resolution. Mirrors workbench's default: `WORKBENCH_STATE_DIR`
 * env when set, else `~/.workbench/driver-state`. Callers (tests, ship's
 * engine under a custom sandbox) can also pass an explicit root straight to
 * `appendEvent`, bypassing both.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function resolveStateRoot(): string {
  const fromEnv = process.env["WORKBENCH_STATE_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return join(homedir(), ".workbench", "driver-state");
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

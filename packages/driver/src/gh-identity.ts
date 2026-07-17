/**
 * Shared gh-identity guard. When a repo's `.ship.json` pins
 * `credentials.gh_host_user`, every `gh` WRITE the driver performs (merge, mark
 * draft-ready) must first verify `gh api user` is authenticated as that login,
 * and refuse on mismatch (or when the login is unreadable). This is the one
 * assertion both write sites call, so identity isolation holds on every mutation,
 * not just `land`. No pinned login → no-op, so repos without the constraint stay
 * byte-identical to today.
 */

import type { DriverRun } from "@ship/store";

import { dirname } from "node:path";

import type { DriverGhPort } from "./gh-port.js";

import { DecideError } from "./errors.js";
import { loadDispatchPolicy } from "./policy.js";

export async function assertGhIdentity(gh: DriverGhPort, run: DriverRun): Promise<void> {
  const loaded = loadDispatchPolicy(dirname(run.manifestPath));
  const expected = loaded.policy.credentials?.ghHostUser;
  if (expected === undefined) {
    return;
  }
  const policyPath = loaded.policyPath ?? ".ship.json";
  const actual = await readGhLogin(gh, policyPath);
  if (actual !== expected) {
    throw new DecideError(
      `gh identity mismatch: ${policyPath} requires login '${expected}' but gh is authenticated as '${actual}' — refusing gh write`,
    );
  }
}

async function readGhLogin(gh: DriverGhPort, policyPath: string): Promise<string> {
  try {
    return await gh.currentUserLogin();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DecideError(
      `cannot verify gh identity required by ${policyPath}: ${detail} — refusing gh write`,
    );
  }
}

/**
 * Default `gh` CLI adapter for driver land (squash merge + PR view).
 */

import type { DriverGhPort, GhPullRequestView } from "@ship/driver";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface GhPrViewJson {
  state: GhPullRequestView["state"];
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
}

export function createExecGhPort(): DriverGhPort {
  return {
    async mergePullRequest(repo: string, prNumber: number): Promise<void> {
      await execFileAsync("gh", [
        "pr",
        "merge",
        String(prNumber),
        "--squash",
        "--admin",
        "--delete-branch",
        "-R",
        repo,
      ]);
    },
    async viewPullRequest(repo: string, prNumber: number): Promise<GhPullRequestView> {
      const { stdout } = await execFileAsync("gh", [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "mergeCommit,mergedAt,state",
        "-R",
        repo,
      ]);
      const parsed = JSON.parse(stdout) as GhPrViewJson;
      return {
        mergeCommit: parsed.mergeCommit ?? null,
        mergedAt: parsed.mergedAt ?? null,
        state: parsed.state,
      };
    },
  };
}

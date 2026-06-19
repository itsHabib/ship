/**
 * Narrow GitHub port for driver policy verbs (merge + read), plus the default
 * `gh` CLI adapter that implements it (squash merge + PR view).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GhMergeCommit {
  oid: string;
}

export interface GhPullRequestView {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeCommit?: GhMergeCommit | null;
  mergedAt?: string | null;
}

export interface GhMergeOpts {
  /** Append `--admin` to the merge (bypass branch protection). Default off. */
  admin?: boolean;
}

export interface DriverGhPort {
  mergePullRequest(repo: string, prNumber: number, opts?: GhMergeOpts): Promise<void>;
  viewPullRequest(repo: string, prNumber: number): Promise<GhPullRequestView>;
}

interface GhPrViewJson {
  state: GhPullRequestView["state"];
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
}

/**
 * Default `gh` CLI adapter. The merge is `gh pr merge <n> --squash
 * --delete-branch`; `--admin` is opt-in (`opts.admin === true`) so the default
 * path respects branch protection and only the operator's flow bypasses it.
 */
export function createExecGhPort(): DriverGhPort {
  return {
    async mergePullRequest(repo: string, prNumber: number, opts?: GhMergeOpts): Promise<void> {
      const args = ["pr", "merge", String(prNumber), "--squash", "--delete-branch", "-R", repo];
      if (opts?.admin === true) {
        args.splice(4, 0, "--admin");
      }
      await execFileAsync("gh", args);
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

/**
 * Narrow GitHub port for driver policy verbs (merge + read), plus the default
 * `gh` CLI adapter that implements it (squash merge + PR view).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Exec seam — run a `gh` subcommand and hand back stdout. Injectable so unit
 * tests drive the adapter's arg-building and JSON parsing without a real `gh`
 * binary on PATH; production omits the arg and gets `defaultGhExec`.
 */
export type GhExec = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;

const defaultGhExec: GhExec = (file, args) => execFileAsync(file, args);

export interface GhMergeCommit {
  oid: string;
}

export interface GhPullRequestView {
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefOid: string;
  mergeCommit?: GhMergeCommit | null;
  mergedAt?: string | null;
}

export interface GhMergeOpts {
  /** Append `--admin` to the merge (bypass branch protection). Default off. */
  admin?: boolean;
}

/** One status check from a PR's `statusCheckRollup`, normalized for the guard. */
export interface GhPrCheck {
  name: string;
  /** Check run / commit status state, e.g. COMPLETED, IN_PROGRESS, QUEUED, PENDING. */
  status: string;
  /** Terminal conclusion, e.g. SUCCESS, FAILURE, SKIPPED, NEUTRAL; "" while non-terminal. */
  conclusion: string;
}

/** Readiness facts the land guard inspects before merging an open PR. */
export interface GhPrReadiness {
  state: GhPullRequestView["state"];
  isDraft: boolean;
  /** Conflict state, e.g. MERGEABLE, CONFLICTING, UNKNOWN. */
  mergeable: string;
  checks: GhPrCheck[];
}

export interface DriverGhPort {
  mergePullRequest(repo: string, prNumber: number, opts?: GhMergeOpts): Promise<void>;
  viewPullRequest(repo: string, prNumber: number): Promise<GhPullRequestView>;
  fetchPrReadiness(repo: string, prNumber: number): Promise<GhPrReadiness>;
  /** Flip a draft PR to ready; idempotent when already ready. Verified write. */
  markReady(repo: string, prNumber: number): Promise<void>;
  /** `gh api user` login of the authenticated account — the gh-identity guard reads this before a write. */
  currentUserLogin(): Promise<string>;
}

interface GhPrViewJson {
  state: GhPullRequestView["state"];
  headRefOid: string;
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
}

interface GhPrRollupNode {
  name?: string | null;
  context?: string | null;
  status?: string | null;
  state?: string | null;
  conclusion?: string | null;
}

interface GhPrReadinessJson {
  state: GhPullRequestView["state"];
  isDraft?: boolean | null;
  mergeable?: string | null;
  statusCheckRollup?: GhPrRollupNode[] | null;
}

/**
 * `gh -R` wants `OWNER/REPO`; driver manifests carry `repo_url` as a full
 * `https://github.com/owner/repo` (or `git@github.com:owner/repo`) URL. Pull
 * out `owner/repo`; pass through a value that is already in short form.
 */
export function toGhRepo(repo: string): string {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repo);
  return match?.[1] ?? repo;
}

/**
 * Default `gh` CLI adapter. The merge is `gh pr merge <n> --squash
 * --delete-branch`; `--admin` is opt-in (`opts.admin === true`) so the default
 * path respects branch protection and only the operator's flow bypasses it.
 */
export function createExecGhPort(exec: GhExec = defaultGhExec): DriverGhPort {
  return {
    async mergePullRequest(repo: string, prNumber: number, opts?: GhMergeOpts): Promise<void> {
      const args = [
        "pr",
        "merge",
        String(prNumber),
        "--squash",
        "--delete-branch",
        "-R",
        toGhRepo(repo),
      ];
      if (opts?.admin === true) {
        args.splice(4, 0, "--admin");
      }
      await exec("gh", args);
    },
    async viewPullRequest(repo: string, prNumber: number): Promise<GhPullRequestView> {
      const { stdout } = await exec("gh", [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "headRefOid,mergeCommit,mergedAt,state",
        "-R",
        toGhRepo(repo),
      ]);
      const parsed = JSON.parse(stdout) as GhPrViewJson;
      return {
        headRefOid: parsed.headRefOid,
        mergeCommit: parsed.mergeCommit ?? null,
        mergedAt: parsed.mergedAt ?? null,
        state: parsed.state,
      };
    },
    async fetchPrReadiness(repo: string, prNumber: number): Promise<GhPrReadiness> {
      const { stdout } = await exec("gh", [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "state,isDraft,mergeable,statusCheckRollup",
        "-R",
        toGhRepo(repo),
      ]);
      const parsed = JSON.parse(stdout) as GhPrReadinessJson;
      return {
        checks: (parsed.statusCheckRollup ?? []).map(normalizeRollupNode),
        isDraft: parsed.isDraft === true,
        mergeable: parsed.mergeable ?? "UNKNOWN",
        state: parsed.state,
      };
    },
    async markReady(repo: string, prNumber: number): Promise<void> {
      const before = await this.fetchPrReadiness(repo, prNumber);
      if (!before.isDraft) {
        return;
      }
      await exec("gh", ["pr", "ready", String(prNumber), "-R", toGhRepo(repo)]);
      const after = await this.fetchPrReadiness(repo, prNumber);
      if (after.isDraft) {
        throw new Error(
          `PR #${String(prNumber)} is still draft after gh pr ready — flip unconfirmed`,
        );
      }
    },
    async currentUserLogin(): Promise<string> {
      const { stdout } = await exec("gh", ["api", "user", "--jq", ".login"]);
      return stdout.trim();
    },
  };
}

/**
 * Normalize a `statusCheckRollup` node into a uniform check. Check-run nodes
 * carry `name`/`status`/`conclusion`; legacy commit-status nodes carry
 * `context`/`state` (terminal) — fold both into `{name,status,conclusion}`.
 */
function normalizeRollupNode(node: GhPrRollupNode): GhPrCheck {
  const name = node.name ?? node.context ?? "(unnamed check)";
  if (node.status !== undefined && node.status !== null) {
    return { conclusion: node.conclusion ?? "", name, status: node.status };
  }
  // Commit-status node: `state` is SUCCESS/FAILURE/ERROR (terminal) or
  // PENDING/EXPECTED (still running). Map the non-terminal states to a
  // non-terminal check so the guard reports "still running", not "failing".
  const state = node.state ?? "";
  if (state === "PENDING" || state === "EXPECTED") {
    return { conclusion: "", name, status: state };
  }
  return { conclusion: state, name, status: "COMPLETED" };
}

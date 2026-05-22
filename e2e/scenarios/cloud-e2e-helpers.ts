/**
 * Shared bits for the three `cloud-*.e2e.test.ts` L3 scenarios:
 * `stripDotGit`, `sandboxSlugFromUrl`, the gate constant, the sandbox URL,
 * and the best-effort cleanup helper.
 *
 * Lives next to the scenarios under `e2e/scenarios/` rather than promoted
 * to `live-open-pr-helpers.ts` because these are cloud-specific (the URL,
 * the double-gate semantics); folding them into the open-pr helpers would
 * widen the open-pr file's scope.
 */

/* eslint-disable sonarjs/no-os-command-from-path -- integration: exercises system `gh`. */

import { execFileSync } from "node:child_process";

/**
 * True only when every input the cloud scenarios need is in the env.
 * `bootstrapFixtureMainOnSandbox` embeds `GITHUB_TOKEN` into the push URL
 * — without it the push fails with a confusing auth error instead of a
 * clean `describe.skipIf` skip, so the token is part of the gate.
 */
export const HAS_KEY_AND_CLOUD =
  process.env["SHIP_LIVE"] === "1" &&
  process.env["SHIP_CLOUD"] === "1" &&
  (process.env["CURSOR_API_KEY"] ?? "") !== "" &&
  (process.env["GITHUB_TOKEN"] ?? "") !== "";

/** Canonical HTTPS remote for Cursor cloud (edit if your sandbox differs). */
export const CLOUD_SANDBOX_REPO_URL = "https://github.com/itsHabib/agent-sandbox";

export function stripDotGit(url: string): string {
  return url.toLowerCase().endsWith(".git") ? url.slice(0, -4) : url;
}

export function sandboxSlugFromUrl(url: string): string {
  const u = new URL(url);
  let seg = u.pathname;
  if (seg.startsWith("/")) seg = seg.slice(1);
  if (seg.endsWith("/")) seg = seg.slice(0, -1);
  if (seg.toLowerCase().endsWith(".git")) seg = seg.slice(0, -4);
  const parts = seg.split("/").filter((p) => p.length > 0);
  if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error(`expected https://github.com/owner/repo URL, got: ${url}`);
  }
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Best-effort cleanup: closes the PR + deletes its branch when a PR
 * number is known; otherwise deletes the branch directly. Used by all
 * three scenarios in `finally` so the sandbox repo doesn't accumulate
 * dead branches across runs.
 */
export function tryCleanupRemoteBranchOrPr(opts: {
  readonly owner: string;
  readonly repo: string;
  readonly prNum: number | undefined;
  readonly branch: string | undefined;
}): void {
  try {
    if (opts.prNum !== undefined) {
      execFileSync(
        "gh",
        [
          "pr",
          "close",
          String(opts.prNum),
          "--repo",
          `${opts.owner}/${opts.repo}`,
          "--delete-branch",
        ],
        { stdio: "ignore" },
      );
    } else if (opts.branch !== undefined) {
      execFileSync(
        "gh",
        ["api", "-X", "DELETE", `repos/${opts.owner}/${opts.repo}/git/refs/heads/${opts.branch}`],
        { stdio: "ignore" },
      );
    }
  } catch {
    /* best-effort cleanup */
  }
}

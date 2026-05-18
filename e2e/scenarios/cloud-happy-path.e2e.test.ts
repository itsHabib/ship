/**
 * L3 live e2e — cloud runtime happy path (`autoCreatePR: true` via
 * `--cloud-auto-create-pr`). Gated on `SHIP_LIVE=1` + `SHIP_CLOUD=1`
 * + `CURSOR_API_KEY`. Cleanup / PR verification use `gh` (expects
 * `GITHUB_TOKEN` or interactive auth like the L4 sandbox flows).
 *
 * Branch + PR info is read from `result.json` (the on-disk
 * `CursorRunResult` per phase doc § F6) — `ShipOutput.cursorRun` has
 * no `branches` field this phase by design (no schema change; the
 * follow-up "open_pr cloud-aware" phase adds `cursor_runs.branches_json`).
 */

/* eslint-disable sonarjs/no-os-command-from-path -- integration: exercises system `gh`. */

import type { CursorRunResult } from "@ship/cursor-runner";
import type { ShipOutput } from "@ship/mcp";

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { startEventTailer } from "./event-tailer.js";
import {
  bootstrapFixtureMainOnSandbox,
  CLI_BIN,
  CLI_PKG,
  isolatedHomeEnv,
  mkLiveTmp,
  parseSandboxSlug,
} from "./live-open-pr-helpers.js";

const HAS_KEY_AND_CLOUD =
  process.env["SHIP_LIVE"] === "1" &&
  process.env["SHIP_CLOUD"] === "1" &&
  (process.env["CURSOR_API_KEY"] ?? "") !== "";

/** Canonical HTTPS remote for Cursor cloud (edit if your sandbox differs). */
const CLOUD_SANDBOX_REPO_URL = "https://github.com/itsHabib/ship-live-sandbox";

function stripDotGit(url: string): string {
  return url.toLowerCase().endsWith(".git") ? url.slice(0, -4) : url;
}

function sandboxSlugFromUrl(url: string): string {
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

function pullNumberFromPrUrl(prUrl: string): number {
  const m = /\/pull\/(\d+)\b/.exec(prUrl);
  if (m?.[1] === undefined) {
    throw new Error(`could not parse PR number from: ${prUrl}`);
  }
  return Number(m[1]);
}

function ghApiJson(path: string): { html_url?: string; state?: string } {
  const out = execFileSync("gh", ["api", path], { encoding: "utf-8" });
  return JSON.parse(out) as { html_url?: string; state?: string };
}

function tryCleanupRemoteBranchOrPr(opts: {
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

describe.skipIf(!HAS_KEY_AND_CLOUD)("L3 cloud e2e — happy path (auto-create PR)", () => {
  test("ship exits 0; result.json carries branch + prUrl; PR resolves via gh", async () => {
    const slug = sandboxSlugFromUrl(CLOUD_SANDBOX_REPO_URL);
    const { owner, repo } = parseSandboxSlug(slug);
    const token = process.env["GITHUB_TOKEN"] ?? "";
    const { root: homeRoot, workdir } = mkLiveTmp("ship-cloud-l3-hp-");
    const repoLabel = `cloud-l3-hp-${randomBytes(4).toString("hex")}`;

    bootstrapFixtureMainOnSandbox({ workdir, token, sandboxSlug: slug });

    const env = isolatedHomeEnv(homeRoot);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        CLI_BIN,
        "ship",
        "docs/features/sandbox.md",
        "--workdir",
        workdir,
        "--repo",
        repoLabel,
        "--runtime",
        "cloud",
        "--cloud-repo",
        stripDotGit(CLOUD_SANDBOX_REPO_URL),
        "--cloud-auto-create-pr",
        "--thinking",
        "low",
        "--json",
      ],
      { cwd: CLI_PKG, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout!.setEncoding("utf-8");
    child.stderr!.setEncoding("utf-8");
    child.stdout!.on("data", (c: string) => {
      stdout += c;
      process.stdout.write(c);
    });
    child.stderr!.on("data", (c: string) => {
      process.stderr.write(`[ship-stderr] ${c}`);
    });
    const tailer = startEventTailer(homeRoot, child);

    let prNum: number | undefined;
    let branchForCleanup: string | undefined;

    try {
      const exitCode = await new Promise<number>((res) => {
        child.on("close", (c) => {
          res(c ?? -1);
        });
      });
      expect(exitCode).toBe(0);
      const shipped = JSON.parse(stdout.trim()) as ShipOutput;
      expect(shipped.status).toBe("succeeded");

      // CursorRunResult is persisted to disk as result.json (§ F6).
      const persisted = JSON.parse(
        readFileSync(shipped.artifacts.resultPath, "utf-8"),
      ) as CursorRunResult;
      expect(persisted.branches.length).toBeGreaterThan(0);
      const b0 = persisted.branches[0]!;
      expect((b0.branch ?? "").length).toBeGreaterThan(0);
      expect((b0.prUrl ?? "").length).toBeGreaterThan(0);

      branchForCleanup = b0.branch;
      prNum = pullNumberFromPrUrl(b0.prUrl!);
      const prJson = ghApiJson(`repos/${owner}/${repo}/pulls/${String(prNum)}`);
      expect(prJson.html_url).toMatch(/pull/);
    } finally {
      tailer.stop();
      tryCleanupRemoteBranchOrPr({ owner, repo, prNum, branch: branchForCleanup });
    }
  });
});

/**
 * L4 live e2e A4 — `open_pr` failure paths (auth, title fallback, push reject).
 *
 * **Quota:** up to 2× Cursor runs + 2× PR attempts + 1× intentional push
 * failure per full file run (subtests share patterns but execute sequentially).
 */

/* eslint-disable sonarjs/no-os-command-from-path -- `gh` + `git` in failure scenarios. */

import type { OpenPrOutput, ShipOutput } from "@ship/mcp";

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { startEventTailer } from "./event-tailer.js";
import {
  bootstrapFixtureMainOnSandbox,
  CLI_BIN,
  CLI_PKG,
  Env,
  hasOpenPrLiveEnv,
  isolatedHomeEnv,
  mkLiveTmp,
  originHttpsUrl,
  parseSandboxSlug,
  parseWorkflowRun,
  runCli,
  runCliSync,
} from "./live-open-pr-helpers.js";

const LIVE = hasOpenPrLiveEnv();

const slug = Env.sandbox;

describe.skipIf(!LIVE)("L4 live e2e — A4 open_pr failure paths", () => {
  describe("missing GitHub token", () => {
    test("open_pr exits 1 with GhAuthError message; open_pr phase failed; no PR", async () => {
      const { root: homeRoot, workdir } = mkLiveTmp("ship-l4-a4-auth-");
      const branch = `tower/live-e2e-${randomBytes(8).toString("hex")}`;
      const repoLabel = `l4-a4-auth-${randomBytes(4).toString("hex")}`;

      bootstrapFixtureMainOnSandbox({ workdir, token: Env.github, sandboxSlug: slug });

      const wfId = await runShipToSucceeded(
        homeRoot,
        workdir,
        repoLabel,
        branch,
        "docs/features/sandbox.md",
      );

      const bad = await runCli(homeRoot, ["open-pr", wfId, "--json"], {
        omitEnv: ["GITHUB_TOKEN", "GH_TOKEN"],
      });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toMatch(/GitHub auth failed:/);

      const st = runCliSync(homeRoot, ["status", wfId, "--json"]);
      const run = parseWorkflowRun(st.stdout);
      const openPrPhases = run.phases.filter((p) => p.kind === "open_pr");
      /* Gh auth fails during idempotency probe before the phase row is persisted. */
      expect(openPrPhases.length).toBe(0);

      const { owner } = parseSandboxSlug(slug);
      const list = spawnSync(
        "gh",
        ["pr", "list", "--repo", slug, "--head", `${owner}:${branch}`, "--json", "number"],
        { encoding: "utf-8" },
      );
      expect(list.status).toBe(0);
      const prs = JSON.parse(list.stdout) as unknown[];
      expect(prs.length).toBe(0);
    });
  });

  describe("malformed task doc (no H1)", () => {
    test("PR title falls back to branch-based inference", async () => {
      const { root: homeRoot, workdir } = mkLiveTmp("ship-l4-a4-title-");
      const tail = randomBytes(4).toString("hex");
      const branch = `tower/live-e2e-malformed-${tail}`;
      const repoLabel = `l4-a4-title-${randomBytes(4).toString("hex")}`;

      bootstrapFixtureMainOnSandbox({ workdir, token: Env.github, sandboxSlug: slug });

      const wfId = await runShipToSucceeded(
        homeRoot,
        workdir,
        repoLabel,
        branch,
        "docs/features/no-h1.md",
      );

      const prR = await runCli(homeRoot, ["open-pr", wfId, "--json"]);
      expect(prR.code).toBe(0);
      const opened = JSON.parse(prR.stdout.trim()) as OpenPrOutput;

      const ghView = spawnSync(
        "gh",
        ["pr", "view", String(opened.prNumber), "--repo", slug, "--json", "title"],
        { encoding: "utf-8" },
      );
      expect(ghView.status).toBe(0);
      const meta = JSON.parse(ghView.stdout) as { title: string };
      expect(meta.title.startsWith("feat:")).toBe(true);
      expect(meta.title.toLowerCase()).toContain("malformed");
    });
  });

  describe("push reject (non-fast-forward)", () => {
    test("BranchPushFailedError surfaces; open_pr phase failed", async () => {
      const divergeBranch = `tower/live-e2e-pushreject-${randomBytes(6).toString("hex")}`;
      const side = mkdtempSync(join(tmpdir(), "ship-l4-pushrej-seed-"));
      const url = originHttpsUrl(Env.github, slug);
      try {
        const { root: homeRoot, workdir } = mkLiveTmp("ship-l4-a4-push-");
        const repoLabel = `l4-a4-push-${randomBytes(4).toString("hex")}`;

        bootstrapFixtureMainOnSandbox({ workdir, token: Env.github, sandboxSlug: slug });

        execFileSync("git", ["clone", url, side]);
        execFileSync("git", ["-C", side, "checkout", "-b", divergeBranch]);
        writeFileSync(join(side, `diverge-${divergeBranch.replace(/\//g, "-")}.txt`), "diverge\n");
        execFileSync("git", ["-C", side, "add", "."]);
        execFileSync("git", ["-C", side, "commit", "-m", "diverge for pushreject"]);
        execFileSync("git", ["-C", side, "push", "-u", "origin", divergeBranch]);

        const wfId = await runShipToSucceeded(
          homeRoot,
          workdir,
          repoLabel,
          divergeBranch,
          "docs/features/sandbox.md",
        );

        const prR = await runCli(homeRoot, ["open-pr", wfId, "--json"]);
        expect(prR.code).toBe(1);
        expect(prR.stderr).toMatch(/git push failed for branch/);

        const st = runCliSync(homeRoot, ["status", wfId, "--json"]);
        const run = parseWorkflowRun(st.stdout);
        const openPr = run.phases.filter((p) => p.kind === "open_pr").at(-1);
        expect(openPr?.status).toBe("failed");
        expect(openPr?.errorMessage ?? "").toMatch(/git push failed/i);
      } finally {
        try {
          execFileSync("git", ["-C", side, "push", url, "--delete", divergeBranch]);
        } catch {
          process.stderr.write(`[e2e] warning: could not delete ${divergeBranch}\n`);
        }
      }
    });
  });
});

async function runShipToSucceeded(
  homeRoot: string,
  workdir: string,
  repoLabel: string,
  branch: string,
  docRel: string,
): Promise<string> {
  const env = isolatedHomeEnv(homeRoot);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      CLI_BIN,
      "ship",
      docRel,
      "--workdir",
      workdir,
      "--repo",
      repoLabel,
      "--branch",
      branch,
      "--json",
      "--thinking",
      "low",
    ],
    {
      cwd: CLI_PKG,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (c: string) => {
    stdout += c;
    process.stdout.write(c);
  });
  child.stderr.on("data", (c: string) => {
    process.stderr.write(`[ship-stderr] ${c}`);
  });
  const tailer = startEventTailer(homeRoot, child);
  try {
    const code = await new Promise<number>((res) => {
      child.on("close", (c) => {
        res(c ?? -1);
      });
    });
    expect(code).toBe(0);
    const shipped = JSON.parse(stdout.trim()) as ShipOutput;
    expect(shipped.status).toBe("succeeded");
    return shipped.workflowRunId;
  } finally {
    tailer.stop();
  }
}

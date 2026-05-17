/**
 * L4 live e2e A4 — `open_pr` failure paths (auth, title fallback, push reject).
 *
 * **Quota:** up to 2× Cursor runs + 2× PR attempts + 1× intentional push
 * failure per full file run (subtests share patterns but execute sequentially).
 */

/* eslint-disable sonarjs/no-os-command-from-path -- `gh` + `git` in failure scenarios. */

import type { OpenPrOutput } from "@ship/mcp";

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  bootstrapFixtureMainOnSandbox,
  Env,
  hasOpenPrLiveEnv,
  mkLiveTmp,
  originHttpsUrl,
  parseSandboxSlug,
  parseWorkflowRun,
  runCli,
  runCliSync,
  runShipExpectingSuccess,
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

      const { workflowRunId: wfId } = await runShipExpectingSuccess({
        homeRoot,
        workdir,
        repoLabel,
        branch,
        docRel: "docs/features/sandbox.md",
      });

      // Auth subtest: re-run the open-pr command with GITHUB_TOKEN omitted.
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

      const { workflowRunId: wfId } = await runShipExpectingSuccess({
        homeRoot,
        workdir,
        repoLabel,
        branch,
        docRel: "docs/features/no-h1.md",
      });

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

        const { workflowRunId: wfId } = await runShipExpectingSuccess({
          homeRoot,
          workdir,
          repoLabel,
          branch: divergeBranch,
          docRel: "docs/features/sandbox.md",
        });

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
        rmSync(side, { recursive: true, force: true });
      }
    });
  });
});

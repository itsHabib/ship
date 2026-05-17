/**
 * L4 live e2e A1 — `ship` + `open-pr` against an operator sandbox repo.
 *
 * **Quota:** 1× Cursor run + 1× GitHub PR per execution (plus sandbox `main`
 * force-push). Gated on `SHIP_LIVE=1`, `CURSOR_API_KEY`, `GITHUB_TOKEN`,
 * `SHIP_E2E_SANDBOX_REPO`.
 */

/* eslint-disable sonarjs/no-os-command-from-path -- exercises system `gh` + `git`. */

import type { OpenPrOutput } from "@ship/mcp";

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  bootstrapFixtureMainOnSandbox,
  Env,
  hasOpenPrLiveEnv,
  mkLiveTmp,
  parseSandboxSlug,
  parseWorkflowRun,
  runCli,
  runCliSync,
  runShipExpectingSuccess,
} from "./live-open-pr-helpers.js";

const LIVE = hasOpenPrLiveEnv();

describe.skipIf(!LIVE)("L4 live e2e — A1 open_pr happy path", () => {
  const slug = Env.sandbox;

  test("ship → open-pr → PR open; open_pr phase succeeded in SQLite", async () => {
    parseSandboxSlug(slug);
    const { root: homeRoot, workdir } = mkLiveTmp("ship-l4-a1-");
    const branch = `tower/live-e2e-${randomBytes(8).toString("hex")}`;
    const repoLabel = `l4-open-pr-a1-${randomBytes(4).toString("hex")}`;

    bootstrapFixtureMainOnSandbox({ workdir, token: Env.github, sandboxSlug: slug });

    const { workflowRunId: wfId } = await runShipExpectingSuccess({
      homeRoot,
      workdir,
      repoLabel,
      branch,
      docRel: "docs/features/sandbox.md",
    });

    const prR = await runCli(homeRoot, ["open-pr", wfId, "--json"]);
    expect(prR.code).toBe(0);
    const opened = JSON.parse(prR.stdout.trim()) as OpenPrOutput;
    expect(opened.prUrl).toMatch(/^https:\/\/github\.com\//);
    expect(opened.alreadyExisted).toBe(false);
    expect(opened.status).toBe("succeeded");

    const ghView = spawnSync(
      "gh",
      [
        "pr",
        "view",
        String(opened.prNumber),
        "--repo",
        slug,
        "--json",
        "state,headRefName,baseRefName",
      ],
      { encoding: "utf-8" },
    );
    expect(ghView.status).toBe(0);
    const prMeta = JSON.parse(ghView.stdout) as {
      state: string;
      headRefName: string;
      baseRefName: string;
    };
    expect(prMeta.state.toUpperCase()).toBe("OPEN");
    expect(prMeta.headRefName).toBe(opened.head);
    expect(prMeta.baseRefName).toBe("main");

    const stR = runCliSync(homeRoot, ["status", wfId, "--json"]);
    expect(stR.code).toBe(0);
    const run = parseWorkflowRun(stR.stdout);
    const openPrPhase = run.phases.filter((p) => p.kind === "open_pr").at(-1);
    expect(openPrPhase?.status).toBe("succeeded");
  });
});

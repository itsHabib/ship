/**
 * L4 live e2e A1 — `ship` + `open-pr` against an operator sandbox repo.
 *
 * **Quota:** 1× Cursor run + 1× GitHub PR per execution (plus sandbox `main`
 * force-push). Gated on `SHIP_LIVE=1`, `CURSOR_API_KEY`, `GITHUB_TOKEN`,
 * `SHIP_E2E_SANDBOX_REPO`.
 */

/* eslint-disable sonarjs/no-os-command-from-path -- exercises system `gh` + `git`. */

import type { OpenPrOutput, ShipOutput } from "@ship/mcp";

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  parseSandboxSlug,
  parseWorkflowRun,
  runCli,
  runCliSync,
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
      const exitCode = await new Promise<number>((res) => {
        child.on("close", (c) => {
          res(c ?? -1);
        });
      });
      expect(exitCode).toBe(0);
      const shipped = JSON.parse(stdout.trim()) as ShipOutput;
      expect(shipped.status).toBe("succeeded");
      const wfId = shipped.workflowRunId;

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
    } finally {
      tailer.stop();
    }
  });
});

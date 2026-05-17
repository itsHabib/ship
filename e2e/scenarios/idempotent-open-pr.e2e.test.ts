/**
 * L4 live e2e A5 — idempotent `open_pr`: second call returns `alreadyExisted: true`
 * with the same `prUrl` against real GitHub.
 *
 * **Quota:** 1× Cursor run + 2× `open_pr` invocations (second is probe-only).
 */

/* eslint-disable sonarjs/no-os-command-from-path -- exercises `gh`. */

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
  runCli,
} from "./live-open-pr-helpers.js";

const LIVE = hasOpenPrLiveEnv();

describe.skipIf(!LIVE)("L4 live e2e — A5 idempotent open_pr", () => {
  const slug = Env.sandbox;

  test("second open_pr returns alreadyExisted + same prUrl", async () => {
    parseSandboxSlug(slug);
    const { root: homeRoot, workdir } = mkLiveTmp("ship-l4-a5-");
    const branch = `tower/live-e2e-${randomBytes(8).toString("hex")}`;
    const repoLabel = `l4-idem-${randomBytes(4).toString("hex")}`;

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

      const first = await runCli(homeRoot, ["open-pr", wfId, "--json"]);
      expect(first.code).toBe(0);
      const opened = JSON.parse(first.stdout.trim()) as OpenPrOutput;
      expect(opened.alreadyExisted).toBe(false);

      const second = await runCli(homeRoot, ["open-pr", wfId, "--json"]);
      expect(second.code).toBe(0);
      const again = JSON.parse(second.stdout.trim()) as OpenPrOutput;
      expect(again.alreadyExisted).toBe(true);
      expect(again.prUrl).toBe(opened.prUrl);
      expect(again.prNumber).toBe(opened.prNumber);

      const { owner } = parseSandboxSlug(slug);
      const list2 = spawnSync(
        "gh",
        ["pr", "list", "--repo", slug, "--head", `${owner}:${again.head}`, "--json", "number"],
        { encoding: "utf-8" },
      );
      expect(list2.status).toBe(0);
      const prs = JSON.parse(list2.stdout) as { number: number }[];
      expect(prs.length).toBe(1);
    } finally {
      tailer.stop();
    }
  });
});

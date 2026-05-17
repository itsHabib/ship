/**
 * L4 live e2e A2 — async-style chain: background `ship`, poll `ship status`,
 * then `open-pr`. Exercises list/status observation without blocking on
 * the child before the workflow row exists.
 *
 * **Quota:** 1× Cursor run + 1× GitHub PR per execution. Requires the same
 * env gate as other open_pr L4 tests.
 */

/* eslint-disable sonarjs/no-os-command-from-path -- exercises system `gh`. */

import type { OpenPrOutput, ShipOutput } from "@ship/mcp";

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  bootstrapFixtureMainOnSandbox,
  Env,
  hasOpenPrLiveEnv,
  mkLiveTmp,
  parseSandboxSlug,
  pollUntilTerminal,
  runCli,
  spawnShipChild,
  waitForWorkflowRowId,
} from "./live-open-pr-helpers.js";

const LIVE = hasOpenPrLiveEnv();

describe.skipIf(!LIVE)("L4 live e2e — A2 ship then open_pr (poll chain)", () => {
  const slug = Env.sandbox;

  test("background ship → poll terminal → open_pr; PR lists agent files", async () => {
    parseSandboxSlug(slug);
    const { root: homeRoot, workdir } = mkLiveTmp("ship-l4-a2-");
    const branch = `tower/live-e2e-${randomBytes(8).toString("hex")}`;
    const repoLabel = `l4-chain-${randomBytes(4).toString("hex")}`;

    bootstrapFixtureMainOnSandbox({ workdir, token: Env.github, sandboxSlug: slug });

    const s = spawnShipChild({
      homeRoot,
      workdir,
      repoLabel,
      branch,
      docRel: "docs/features/sandbox.md",
    });
    try {
      const wfId = await waitForWorkflowRowId(homeRoot, repoLabel);
      const terminal = await pollUntilTerminal(homeRoot, wfId);
      expect(terminal.status).toBe("succeeded");

      const { exitCode, stdout } = await s.waitForClose();
      expect(exitCode).toBe(0);
      const shipped = JSON.parse(stdout.trim()) as ShipOutput;
      expect(shipped.workflowRunId).toBe(wfId);
      expect(shipped.status).toBe("succeeded");

      const prR = await runCli(homeRoot, ["open-pr", wfId, "--json"]);
      expect(prR.code).toBe(0);
      const opened = JSON.parse(prR.stdout.trim()) as OpenPrOutput;
      expect(opened.alreadyExisted).toBe(false);

      const filesProbe = spawnSync(
        "gh",
        ["pr", "view", String(opened.prNumber), "--repo", slug, "--json", "files"],
        { encoding: "utf-8" },
      );
      expect(filesProbe.status).toBe(0);
      const filesBody = JSON.parse(filesProbe.stdout) as { files?: { path: string }[] };
      expect(filesBody.files?.length ?? 0).toBeGreaterThan(0);
    } finally {
      s.stop();
    }
  });
});

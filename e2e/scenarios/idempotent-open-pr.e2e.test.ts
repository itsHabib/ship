/**
 * L4 live e2e A5 — idempotent `open_pr`: second call returns `alreadyExisted: true`
 * with the same `prUrl` against real GitHub.
 *
 * **Quota:** 1× Cursor run + 2× `open_pr` invocations (second is probe-only).
 */

/* eslint-disable sonarjs/no-os-command-from-path -- exercises `gh`. */

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
  runCli,
  runShipExpectingSuccess,
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

    const { workflowRunId: wfId } = await runShipExpectingSuccess({
      homeRoot,
      workdir,
      repoLabel,
      branch,
      docRel: "docs/features/sandbox.md",
    });

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
    // Tighter than `length: 1` — verify the listed PR is the SAME one the
    // first open-pr returned. Catches a hypothetical regression where
    // open_pr closes + reopens (would pass `length: 1` but `number` would
    // differ).
    expect(prs[0]?.number).toBe(opened.prNumber);
  });
});

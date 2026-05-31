/**
 * L3 live e2e — cloud artifact download. Gated on `SHIP_LIVE=1` +
 * `SHIP_CLOUD=1` + `CURSOR_API_KEY` + `GITHUB_TOKEN`.
 */

import type { ShipOutput } from "@ship/mcp";

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  CLOUD_SANDBOX_REPO_URL,
  HAS_KEY_AND_CLOUD,
  sandboxSlugFromUrl,
  stripDotGit,
  tryCleanupRemoteBranchOrPr,
} from "./cloud-e2e-helpers.js";
import { startEventTailer } from "./event-tailer.js";
import {
  bootstrapFixtureMainOnSandbox,
  CLI_BIN,
  CLI_PKG,
  isolatedHomeEnv,
  mkLiveTmp,
  parseSandboxSlug,
} from "./live-cli-helpers.js";

describe.skipIf(!HAS_KEY_AND_CLOUD)("L3 cloud e2e — artifact download", () => {
  test("cloud run writes marker file; artifacts download returns bytes", async () => {
    const slug = sandboxSlugFromUrl(CLOUD_SANDBOX_REPO_URL);
    const { owner, repo } = parseSandboxSlug(slug);
    const token = process.env["GITHUB_TOKEN"] ?? "";
    const { root: homeRoot, workdir } = mkLiveTmp("ship-cloud-artifact-");
    const repoLabel = `cloud-art-${randomBytes(4).toString("hex")}`;
    const marker = `ship-artifact-${randomBytes(4).toString("hex")}`;

    bootstrapFixtureMainOnSandbox({ workdir, token, sandboxSlug: slug });

    const docPath = `${workdir}/artifact-task.md`;
    writeFileSync(
      docPath,
      [
        "# Artifact smoke",
        "",
        "Write exactly one file at path `ship-artifact-marker.txt` in the repo root with this single line of content:",
        marker,
        "Do not commit. Do not open a PR.",
      ].join("\n"),
      "utf8",
    );

    const env = isolatedHomeEnv(homeRoot);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        CLI_BIN,
        "ship",
        docPath,
        "--workdir",
        workdir,
        "--repo",
        repoLabel,
        "--runtime",
        "cloud",
        "--cloud-repo",
        stripDotGit(CLOUD_SANDBOX_REPO_URL),
        "--cloud-auto-create-pr",
        "false",
        "--json",
      ],
      { cwd: CLI_PKG, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr!.on("data", (c: string) => {
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

      const listJson = execFileSync(
        process.execPath,
        ["--import", "tsx/esm", CLI_BIN, "artifacts", "list", shipped.workflowRunId, "--json"],
        { cwd: CLI_PKG, env, encoding: "utf-8" },
      );
      const listed = JSON.parse(listJson) as { artifacts: { path: string }[] };
      const entry = listed.artifacts.find((a) => a.path.includes("ship-artifact-marker"));
      expect(entry, JSON.stringify(listed)).toBeDefined();

      const localPath = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          CLI_BIN,
          "artifacts",
          "download",
          shipped.workflowRunId,
          entry!.path,
        ],
        { cwd: CLI_PKG, env, encoding: "utf-8" },
      ).trim();
      expect(readFileSync(localPath, "utf-8").trim()).toBe(marker);
    } finally {
      tailer.stop();
      tryCleanupRemoteBranchOrPr({ owner, repo, prNum: undefined, branch: undefined });
    }
  }, 600_000);
});

/**
 * L3 live e2e — cancel during cloud `CREATING` (first `type: "status"`
 * event). Gated on `SHIP_LIVE=1` + `SHIP_CLOUD=1` + `CURSOR_API_KEY`.
 */

import type { ShipOutput } from "@ship/mcp";

import { Agent, type SDKAgentInfo } from "@cursor/sdk";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";

import { startEventTailer } from "./event-tailer.js";
import {
  bootstrapFixtureMainOnSandbox,
  CLI_BIN,
  CLI_PKG,
  isolatedHomeEnv,
  mkLiveTmp,
  parseSandboxSlug,
  runCli,
  waitForEventsNdjsonPredicate,
  waitForWorkflowRowId,
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

function ndjsonHasCloudCreatingLine(content: string): boolean {
  return content.split("\n").some((line) => {
    const t = line.trim();
    if (t === "") return false;
    try {
      const o = JSON.parse(t) as { type?: string; status?: unknown };
      return (
        o.type === "status" && typeof o.status === "string" && o.status.toUpperCase() === "CREATING"
      );
    } catch {
      return false;
    }
  });
}

async function cloudAgentRecordsForId(agentId: string): Promise<SDKAgentInfo[]> {
  const found: SDKAgentInfo[] = [];
  let nextCursor: string | undefined;
  const apiKey = process.env["CURSOR_API_KEY"] ?? "";
  for (;;) {
    const page = await Agent.list({
      runtime: "cloud",
      apiKey,
      limit: 100,
      ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
    });
    for (const it of page.items) {
      if (it.agentId === agentId) found.push(it);
    }
    nextCursor = page.nextCursor;
    if (nextCursor === undefined) break;
  }
  return found;
}

interface CloudShipChild {
  readonly waitForClose: () => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  readonly stop: () => void;
}

function spawnCloudShipAsF1(opts: {
  readonly homeRoot: string;
  readonly workdir: string;
  readonly repoLabel: string;
}): CloudShipChild {
  const env = isolatedHomeEnv(opts.homeRoot);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      CLI_BIN,
      "ship",
      "docs/features/long.md",
      "--workdir",
      opts.workdir,
      "--repo",
      opts.repoLabel,
      "--runtime",
      "cloud",
      "--cloud-repo",
      stripDotGit(CLOUD_SANDBOX_REPO_URL),
      "--cloud-auto-create-pr",
      "--thinking",
      "low",
      "--json",
    ],
    {
      cwd: CLI_PKG,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
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
  const tailer = startEventTailer(opts.homeRoot, child);
  const closePromise = new Promise<{ readonly exitCode: number; readonly stdout: string }>(
    (res) => {
      child.on("close", (c) => {
        res({ exitCode: c ?? -1, stdout });
      });
    },
  );
  return {
    waitForClose: () => closePromise,
    stop: () => {
      tailer.stop();
    },
  };
}

describe.skipIf(!HAS_KEY_AND_CLOUD)("L3 cloud e2e — cancel during CREATING", () => {
  test("cancel on first cloud CREATING status event → workflow cancelled; no orphan agent", async () => {
    const slug = sandboxSlugFromUrl(CLOUD_SANDBOX_REPO_URL);
    parseSandboxSlug(slug);
    const token = process.env["GITHUB_TOKEN"] ?? "";
    const { root: homeRoot, workdir } = mkLiveTmp("ship-cloud-l3-cancel-");
    const repoLabel = `cloud-l3-cncl-${randomBytes(4).toString("hex")}`;

    bootstrapFixtureMainOnSandbox({ workdir, token, sandboxSlug: slug });

    const s = spawnCloudShipAsF1({ homeRoot, workdir, repoLabel });
    try {
      const wfId = await waitForWorkflowRowId(homeRoot, repoLabel);
      await waitForEventsNdjsonPredicate({
        homeRoot,
        predicate: (_path, content) => ndjsonHasCloudCreatingLine(content),
        timeoutMs: 120_000,
      });
      const cancelR = await runCli(homeRoot, ["cancel", wfId, "--json"]);
      expect(cancelR.code).toBe(0);

      const { exitCode, stdout } = await s.waitForClose();
      expect(exitCode).toBe(0);
      const shipOut = JSON.parse(stdout.trim()) as ShipOutput;
      expect(shipOut.status).toBe("cancelled");

      const matches = await cloudAgentRecordsForId(shipOut.cursorRun.agentId);
      const running = matches.filter((m) => m.status === "running");
      try {
        expect(running.length).toBe(0);
      } catch (err) {
        process.stderr.write(
          `[cloud-l3-cancel] TODO(cloud-spec): assertion failed (${String(err)}); agent list matches: ${JSON.stringify(matches)}\n`,
        );
        throw err;
      }
    } finally {
      s.stop();
    }
  });
});

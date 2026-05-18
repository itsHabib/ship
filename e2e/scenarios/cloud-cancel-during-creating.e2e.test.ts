/**
 * L3 live e2e — cancel during cloud `CREATING` (first `type: "status"`
 * event). Gated on `SHIP_LIVE=1` + `SHIP_CLOUD=1` + `CURSOR_API_KEY`
 * + `GITHUB_TOKEN`.
 */

import type { CursorRunResult } from "@ship/cursor-runner";
import type { ShipOutput } from "@ship/mcp";

import { Agent, type SDKAgentInfo } from "@cursor/sdk";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  runCli,
  waitForEventsNdjsonPredicate,
  waitForWorkflowRowId,
} from "./live-open-pr-helpers.js";

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

function spawnCloudShipChild(opts: {
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
    // Validate the URL parses to owner/repo before spawning anything — cheap
    // pre-flight check so a malformed CLOUD_SANDBOX_REPO_URL fails fast.
    const { owner, repo } = parseSandboxSlug(slug);
    const token = process.env["GITHUB_TOKEN"] ?? "";
    const { root: homeRoot, workdir } = mkLiveTmp("ship-cloud-l3-cancel-");
    const repoLabel = `cloud-l3-cncl-${randomBytes(4).toString("hex")}`;

    bootstrapFixtureMainOnSandbox({ workdir, token, sandboxSlug: slug });

    const s = spawnCloudShipChild({ homeRoot, workdir, repoLabel });
    let branchForCleanup: string | undefined;
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

      // If a partial cloud run pushed a branch before the cancel landed, the
      // run's result.json may carry it. Best-effort grab so `finally` can
      // clean it off the sandbox repo.
      if (existsSync(shipOut.artifacts.resultPath)) {
        try {
          const persisted = JSON.parse(
            readFileSync(shipOut.artifacts.resultPath, "utf-8"),
          ) as CursorRunResult;
          branchForCleanup = persisted.branches[0]?.branch;
        } catch {
          /* result.json missing or partial — nothing to clean */
        }
      }

      const matches = await cloudAgentRecordsForId(shipOut.cursorRun.agentId);
      // Cycle-2 codex P2: filter only catches non-terminal states, normalized to
      // lowercase. SDK doc shapes are split — `Run.status` is lowercase
      // (`"running" | "finished" | "error" | "cancelled"`) and stream
      // `SDKStatusMessage.status` is uppercase. `SDKAgentInfo.status` from
      // `Agent.list` isn't called out explicitly; the cursor-runner mock at
      // `cloud-runner.test.ts:89` uses lowercase. Normalize defensively and
      // assert against the **terminal** allow-list rather than the running
      // single-literal — otherwise an agent stuck in `CREATING` after a
      // cancel race wouldn't be flagged.
      const TERMINAL_STATES = new Set(["finished", "error", "cancelled", "expired"]);
      const nonTerminal = matches.filter(
        (m) => !TERMINAL_STATES.has((m.status ?? "").toLowerCase()),
      );
      try {
        expect(nonTerminal.length).toBe(0);
      } catch (err) {
        process.stderr.write(
          `[cloud-l3-cancel] TODO(cloud-spec): assertion failed (${String(err)}); agent list matches: ${JSON.stringify(matches)}\n`,
        );
        throw err;
      }
    } finally {
      s.stop();
      tryCleanupRemoteBranchOrPr({
        owner,
        repo,
        prNum: undefined,
        branch: branchForCleanup,
      });
    }
  });
});

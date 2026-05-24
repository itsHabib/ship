/**
 * L3 live e2e — cloud resume across Ship-process restart.
 *
 * Fires a real cloud `ship.ship`, SIGTERM-kills the CLI mid-flight,
 * restarts Ship against the same DB, and asserts `ship.resumed` lands in
 * `events.ndjson` before the original `workflowRunId` reaches terminal.
 *
 * Gated on `SHIP_LIVE=1` + `SHIP_CLOUD=1` + `CURSOR_API_KEY` +
 * `GITHUB_TOKEN`. Burns real Cursor cloud time (~60s sleep workload +
 * resume margin) — do not enable in CI.
 *
 * Prompt uses `sleep 60 && echo done` (not a print loop) because
 * composer-2.5 collapses rate-hinted loops; see phase 08 spike.
 */

import { Agent } from "@cursor/sdk";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  CLOUD_SANDBOX_REPO_URL,
  connectRestartMcpSession,
  HAS_KEY_AND_CLOUD,
  killShipProcess,
  readCursorRunForWorkflow,
  type RestartMcpSession,
  sandboxSlugFromUrl,
  shipDbPathFromHome,
  stripDotGit,
  waitForWorkflowTerminalInDb,
} from "./cloud-e2e-helpers.js";
import { startEventTailer } from "./event-tailer.js";
import {
  bootstrapFixtureMainOnSandbox,
  CLI_BIN,
  CLI_PKG,
  isolatedHomeEnv,
  mkLiveTmp,
  parseListRuns,
  parseSandboxSlug,
  runCliSync,
  sleep,
  waitForEventsNdjsonPredicate,
  waitForWorkflowRowId,
} from "./live-cli-helpers.js";

const RESUME_SLEEP_DOC = `# Cloud resume L3 — sleep workload

Run exactly this shell command in the cloud VM and wait for it to finish before responding:

\`\`\`bash
sleep 60 && echo done
\`\`\`

After the command completes, print \`done\` on its own line. Do nothing else — no file edits, no PR, no git operations.
`;

interface CloudShipChild {
  readonly child: ChildProcess;
  readonly stop: () => void;
}

function spawnCloudResumeShipChild(opts: {
  readonly homeRoot: string;
  readonly workdir: string;
  readonly repoLabel: string;
  readonly docRel: string;
}): CloudShipChild {
  const env = isolatedHomeEnv(opts.homeRoot);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      CLI_BIN,
      "ship",
      opts.docRel,
      "--workdir",
      opts.workdir,
      "--repo",
      opts.repoLabel,
      "--runtime",
      "cloud",
      "--cloud-repo",
      stripDotGit(CLOUD_SANDBOX_REPO_URL),
      "--model-param",
      "fast=false",
      "--json",
    ],
    {
      cwd: CLI_PKG,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.setEncoding("utf-8");
  child.stderr!.setEncoding("utf-8");
  child.stdout!.on("data", (c: string) => {
    process.stdout.write(c);
  });
  child.stderr!.on("data", (c: string) => {
    process.stderr.write(`[ship-stderr] ${c}`);
  });
  const tailer = startEventTailer(opts.homeRoot, child);
  return {
    child,
    stop: () => {
      tailer.stop();
      // Defensive: if the test throws before killShipProcess runs (e.g.,
      // waitForCursorRunRunning times out, vitest's test timeout fires),
      // the spawned ship-cli would be orphaned. Send SIGTERM if it's
      // still alive. Per cycle-1 review (Claude P1).
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
    },
  };
}

async function waitForCursorRunRunning(opts: {
  readonly dbPath: string;
  readonly workflowRunId: string;
  readonly timeoutMs: number;
}): Promise<{ readonly id: string; readonly agentId: string; readonly runId: string }> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const row = readCursorRunForWorkflow(opts.dbPath, opts.workflowRunId);
    if (row?.status === "running" && row.runId !== null && row.runId.length > 0) {
      return { id: row.id, agentId: row.agentId, runId: row.runId };
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for cursor_run running (workflowRunId=${opts.workflowRunId})`);
}

function ndjsonHasShipResumed(_path: string, content: string): boolean {
  return content.split("\n").some((line) => {
    const t = line.trim();
    if (t === "") return false;
    try {
      const o = JSON.parse(t) as { type?: string };
      return o.type === "ship.resumed";
    } catch {
      return false;
    }
  });
}

async function archiveCloudAgent(agentId: string): Promise<void> {
  const apiKey = process.env["CURSOR_API_KEY"] ?? "";
  try {
    await Agent.archive(agentId, { apiKey });
  } catch (err) {
    // Best-effort cleanup. Logged (not silent) so a failed archive
    // surfaces in test output — an unarchived agent keeps running on
    // Cursor's VM until the retention window expires. Per cycle-1
    // review (Claude P2).
    console.warn(`[cloud-resume] Agent.archive failed (best-effort): ${String(err)}`);
  }
}

describe.skipIf(!HAS_KEY_AND_CLOUD)("L3 cloud e2e — resume after process kill", () => {
  // Sequential waits add up to ~405s (120 cursor_run + 15 ship.resumed +
  // 270 terminal) which overflows e2e/vitest.e2e.config.ts's 300s global
  // testTimeout. Per cycle-1 review (Claude P1), give this single test
  // its own 8-minute budget — the cloud run itself is ~60s sleep plus
  // overhead, so 8min has plenty of headroom without sitting on the
  // global ceiling.
  test(
    "kill mid-flight, restart Ship, same workflowRunId completes with ship.resumed",
    { timeout: 8 * 60_000 },
    async () => {
      const slug = sandboxSlugFromUrl(CLOUD_SANDBOX_REPO_URL);
      // Extra structural validation. sandboxSlugFromUrl already throws on
      // a malformed URL, but parseSandboxSlug enforces the slug-shape
      // contract independently — void-prefixed to mark the side-effect intent.
      void parseSandboxSlug(slug);
      const token = process.env["GITHUB_TOKEN"] ?? "";
      const { root: homeRoot, workdir } = mkLiveTmp("ship-cloud-l3-resume-");
      const repoLabel = `cloud-l3-rsm-${randomBytes(4).toString("hex")}`;
      const dbPath = shipDbPathFromHome(homeRoot);

      bootstrapFixtureMainOnSandbox({ workdir, token, sandboxSlug: slug });

      const docRel = "docs/features/resume-sleep.md";
      mkdirSync(join(workdir, "docs", "features"), { recursive: true });
      writeFileSync(join(workdir, docRel), RESUME_SLEEP_DOC, "utf-8");

      const shipChild = spawnCloudResumeShipChild({ homeRoot, workdir, repoLabel, docRel });
      let agentId: string | undefined;
      let restartSession: RestartMcpSession | undefined;

      try {
        const workflowRunId = await waitForWorkflowRowId(homeRoot, repoLabel);
        const cursorRun = await waitForCursorRunRunning({
          dbPath,
          workflowRunId,
          timeoutMs: 120_000,
        });
        agentId = cursorRun.agentId;
        expect(cursorRun.runId.length).toBeGreaterThan(0);

        await killShipProcess(shipChild.child);

        const midRow = readCursorRunForWorkflow(dbPath, workflowRunId);
        expect(midRow?.status).toBe("running");

        restartSession = await connectRestartMcpSession({ homeRoot, workflowRunId });
        await waitForEventsNdjsonPredicate({
          homeRoot,
          predicate: ndjsonHasShipResumed,
          timeoutMs: 15_000,
        });

        const postResumeRow = readCursorRunForWorkflow(dbPath, workflowRunId);
        expect(postResumeRow?.status).toBe("running");

        const terminalStatus = await waitForWorkflowTerminalInDb({
          dbPath,
          workflowRunId,
          timeoutMs: 4.5 * 60_000,
        });
        expect(terminalStatus).toBe("succeeded");

        const listR = runCliSync(homeRoot, ["list", "--repo", repoLabel, "--json"]);
        expect(listR.code).toBe(0);
        const listed = parseListRuns(listR.stdout);
        expect(listed.runs).toHaveLength(1);
        expect(listed.runs[0]?.id).toBe(workflowRunId);
        expect(listed.runs[0]?.status).toBe("succeeded");
      } finally {
        shipChild.stop();
        if (restartSession !== undefined) {
          await restartSession.close();
        }
        if (agentId !== undefined) {
          await archiveCloudAgent(agentId);
        }
      }
    },
  );
});

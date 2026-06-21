/**
 * L3 live e2e — cloud `ship.ship` with no `workdir` and no `repo`.
 * Exercises MCP parity (phase 09): synthetic worktree, repo auto-derive,
 * default `autoCreatePR: true`. Gated on `SHIP_LIVE=1` + `SHIP_CLOUD=1`
 * + `CURSOR_API_KEY` + `GITHUB_TOKEN`.
 */

/* eslint-disable sonarjs/no-os-command-from-path -- integration: exercises system `gh`. */

import type { AgentRunResult } from "@ship/cursor-runner";
import type { ShipStartOutput } from "@ship/mcp";
import type { WorkflowRun } from "@ship/workflow";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { waitForTerminalRun } from "@ship/test-harness";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  CLOUD_SANDBOX_REPO_URL,
  HAS_KEY_AND_CLOUD,
  sandboxSlugFromUrl,
  stripDotGit,
  tryCleanupRemoteBranchOrPr,
} from "./cloud-e2e-helpers.js";
import {
  bootstrapFixtureMainOnSandbox,
  isolatedHomeEnv,
  LIVE_SANDBOX_FIXTURE,
  mkLiveTmp,
  parseSandboxSlug,
} from "./live-cli-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_PKG = resolve(HERE, "..", "..", "packages", "mcp-server");
const MCP_BIN = join(MCP_PKG, "src", "bin.ts");

const CLOUD_POLL = { maxAttempts: 600, intervalMs: 2000 } as const;

function pullNumberFromPrUrl(prUrl: string): number {
  const m = /\/pull\/(\d+)\b/.exec(prUrl);
  if (m?.[1] === undefined) {
    throw new Error(`could not parse PR number from: ${prUrl}`);
  }
  return Number(m[1]);
}

function ghApiJson(path: string): { html_url?: string; state?: string } {
  const out = execFileSync("gh", ["api", path], { encoding: "utf-8" });
  return JSON.parse(out) as { html_url?: string; state?: string };
}

function parseToolJson(result: unknown): unknown {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const block = r.content?.[0];
  if (block?.type !== "text" || typeof block.text !== "string") {
    throw new Error(`unexpected tool response shape: ${JSON.stringify(result)}`);
  }
  if (r.isError === true) {
    throw new Error(`tool returned isError: ${block.text}`);
  }
  return JSON.parse(block.text);
}

function filterEnvForStdio(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

describe.skipIf(!HAS_KEY_AND_CLOUD)("L3 cloud e2e — no workdir / no repo (MCP)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let homeRoot: string;
  let docPath: string;

  beforeEach(async () => {
    const slug = sandboxSlugFromUrl(CLOUD_SANDBOX_REPO_URL);
    const token = process.env["GITHUB_TOKEN"] ?? "";
    const live = mkLiveTmp("ship-cloud-l3-nowd-");
    homeRoot = live.root;
    const bootstrapWorkdir = live.workdir;

    bootstrapFixtureMainOnSandbox({ workdir: bootstrapWorkdir, token, sandboxSlug: slug });

    docPath = join(homeRoot, "external-task-doc.md");
    writeFileSync(
      docPath,
      readFileSync(join(LIVE_SANDBOX_FIXTURE, "docs", "features", "sandbox.md"), "utf-8"),
    );

    const dbPath = join(homeRoot, "state.db");
    const runsDir = join(homeRoot, "runs");
    const env = isolatedHomeEnv(homeRoot);
    env["SHIP_DB_PATH"] = dbPath;
    env["SHIP_RUNS_DIR"] = runsDir;
    delete env["SHIP_TEST_FAKE_CURSOR"];

    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx/esm", MCP_BIN],
      env: filterEnvForStdio(env),
      cwd: MCP_PKG,
    });
    client = new Client({ name: "ship-cloud-no-workdir-e2e", version: "0.0.0" });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
  });

  test("MCP ship without workdir/repo succeeds; repo derived; PR auto-opened", async () => {
    const slug = sandboxSlugFromUrl(CLOUD_SANDBOX_REPO_URL);
    const { owner, repo } = parseSandboxSlug(slug);

    const shippedRaw = await client.callTool({
      name: "ship",
      arguments: {
        docPath,
        runtime: "cloud",
        cloud: { repos: [{ url: stripDotGit(CLOUD_SANDBOX_REPO_URL) }] },
        modelParams: [{ id: "fast", value: false }],
      },
    });
    const shipped = parseToolJson(shippedRaw) as ShipStartOutput;
    expect(shipped.status).toBe("running");

    let prNum: number | undefined;
    let branchForCleanup: string | undefined;

    try {
      const terminal = (await waitForTerminalRun(
        client,
        shipped.workflowRunId,
        CLOUD_POLL,
      )) as WorkflowRun;
      expect(terminal.status).toBe("succeeded");
      expect(terminal.repo).toBe(slug);
      expect(terminal.worktree.path).toBe("(cloud)");
      expect(terminal.worktree.name).toBe("(cloud)");

      const got = await client.callTool({
        name: "get_workflow_run",
        arguments: { workflowRunId: shipped.workflowRunId },
      });
      const hydrated = parseToolJson(got) as WorkflowRun;
      const resultPath = join(homeRoot, "runs", shipped.workflowRunId, "result.json");
      const persisted = JSON.parse(readFileSync(resultPath, "utf-8")) as AgentRunResult;
      expect(persisted.branches.length).toBeGreaterThan(0);
      const b0 = persisted.branches[0]!;
      expect((b0.branch ?? "").length).toBeGreaterThan(0);
      expect(b0.prUrl?.startsWith("https://github.com/")).toBe(true);

      branchForCleanup = b0.branch;
      prNum = pullNumberFromPrUrl(b0.prUrl!);
      const prJson = ghApiJson(`repos/${owner}/${repo}/pulls/${String(prNum)}`);
      expect(prJson.html_url).toMatch(/\/pull\/\d+/);
      expect(prJson.state).toBe("open");
      expect(hydrated.repo).toBe(slug);
    } finally {
      tryCleanupRemoteBranchOrPr({ owner, repo, prNum, branch: branchForCleanup });
    }
  });
});

/**
 * L3 live e2e — cloud `ship.ship` with no local task doc.
 * The docPath exists only on the remote repo branch; ship fetches it
 * via GitHub and embeds into `task-doc.md`. Gated on `SHIP_LIVE=1` +
 * `SHIP_CLOUD=1` + `CURSOR_API_KEY` + `GITHUB_TOKEN`.
 */

import type { ShipStartOutput } from "@ship/mcp";
import type { WorkflowRun } from "@ship/workflow";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { waitForTerminalRun } from "@ship/test-harness";
import { readFileSync } from "node:fs";
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

const REMOTE_DOC_PATH = "docs/features/sandbox.md";
const EXPECTED_DOC = readFileSync(
  join(LIVE_SANDBOX_FIXTURE, "docs", "features", "sandbox.md"),
  "utf-8",
);

const CLOUD_POLL = { maxAttempts: 600, intervalMs: 2000 } as const;

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

describe.skipIf(!HAS_KEY_AND_CLOUD)("L3 cloud e2e — no local doc (MCP)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let homeRoot: string;

  beforeEach(async () => {
    const slug = sandboxSlugFromUrl(CLOUD_SANDBOX_REPO_URL);
    const token = process.env["GITHUB_TOKEN"] ?? "";
    const live = mkLiveTmp("ship-cloud-l3-nolocaldoc-");
    homeRoot = live.root;
    const bootstrapWorkdir = live.workdir;

    bootstrapFixtureMainOnSandbox({ workdir: bootstrapWorkdir, token, sandboxSlug: slug });

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
    client = new Client({ name: "ship-cloud-no-local-doc-e2e", version: "0.0.0" });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
  });

  test("MCP ship with repo-only docPath fetches remote doc into task-doc.md", async () => {
    const slug = sandboxSlugFromUrl(CLOUD_SANDBOX_REPO_URL);
    const { owner, repo } = parseSandboxSlug(slug);

    const shippedRaw = await client.callTool({
      name: "ship",
      arguments: {
        docPath: REMOTE_DOC_PATH,
        runtime: "cloud",
        cloud: { repos: [{ url: stripDotGit(CLOUD_SANDBOX_REPO_URL) }] },
        modelParams: [{ id: "fast", value: false }],
      },
    });
    const shipped = parseToolJson(shippedRaw) as ShipStartOutput;
    expect(shipped.status).toBe("running");

    let branchForCleanup: string | undefined;

    try {
      const terminal = (await waitForTerminalRun(
        client,
        shipped.workflowRunId,
        CLOUD_POLL,
      )) as WorkflowRun;
      expect(terminal.status).toBe("succeeded");

      const taskDocPath = join(homeRoot, "runs", shipped.workflowRunId, "task-doc.md");
      const taskDoc = readFileSync(taskDocPath, "utf-8");
      expect(taskDoc).toBe(EXPECTED_DOC);

      const resultPath = join(homeRoot, "runs", shipped.workflowRunId, "result.json");
      const persisted = JSON.parse(readFileSync(resultPath, "utf-8")) as {
        branches?: { branch?: string; prUrl?: string }[];
      };
      branchForCleanup = persisted.branches?.[0]?.branch;
    } finally {
      tryCleanupRemoteBranchOrPr({ owner, repo, prNum: undefined, branch: branchForCleanup });
    }
  });
});

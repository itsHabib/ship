/**
 * Shared bits for the `cloud-*.e2e.test.ts` L3 scenarios:
 * `stripDotGit`, `sandboxSlugFromUrl`, the gate constant, the sandbox URL,
 * best-effort cleanup, and kill/restart helpers for the resume scenario.
 *
 * Lives next to the scenarios under `e2e/scenarios/` rather than promoted
 * to `live-open-pr-helpers.ts` because these are cloud-specific (the URL,
 * the double-gate semantics); folding them into the open-pr helpers would
 * widen the open-pr file's scope.
 */

/* eslint-disable sonarjs/no-os-command-from-path -- integration: exercises system `gh`. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { type ChildProcess, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isolatedHomeEnv, sleep } from "./live-open-pr-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_PKG = resolve(HERE, "..", "..", "packages", "mcp-server");
const MCP_BIN = join(MCP_PKG, "src", "bin.ts");

/**
 * True only when every input the cloud scenarios need is in the env.
 * `bootstrapFixtureMainOnSandbox` embeds `GITHUB_TOKEN` into the push URL
 * — without it the push fails with a confusing auth error instead of a
 * clean `describe.skipIf` skip, so the token is part of the gate.
 */
export const HAS_KEY_AND_CLOUD =
  process.env["SHIP_LIVE"] === "1" &&
  process.env["SHIP_CLOUD"] === "1" &&
  (process.env["CURSOR_API_KEY"] ?? "") !== "" &&
  (process.env["GITHUB_TOKEN"] ?? "") !== "";

/** Canonical HTTPS remote for Cursor cloud (edit if your sandbox differs). */
export const CLOUD_SANDBOX_REPO_URL = "https://github.com/itsHabib/agent-sandbox";

export function stripDotGit(url: string): string {
  return url.toLowerCase().endsWith(".git") ? url.slice(0, -4) : url;
}

export function sandboxSlugFromUrl(url: string): string {
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

/**
 * SQLite path for an isolated Ship home tree. Matches CLI `resolveDbPath`
 * when `isolatedHomeEnv` sets `HOME` / `APPDATA` to `homeRoot` (Windows
 * uses `%APPDATA%/ship/...`, not `%APPDATA%/Roaming/ship/...`).
 */
export function shipDbPathFromHome(homeRoot: string): string {
  if (process.platform === "win32") {
    return join(homeRoot, "ship", "state.db");
  }
  return join(homeRoot, ".config", "ship", "state.db");
}

/** Artifacts dir for an isolated Ship home tree (matches CLI `resolveRunsDir`). */
export function shipRunsDirFromHome(homeRoot: string): string {
  if (process.platform === "win32") {
    return join(homeRoot, "ship", "runs");
  }
  return join(homeRoot, ".config", "ship", "runs");
}

/** Row shape read from `cursor_runs` for resume-scenario assertions. */
export interface CursorRunDbRow {
  readonly id: string;
  readonly workflowRunId: string;
  readonly agentId: string;
  readonly runId: string | null;
  readonly status: string;
}

/** Point-read the newest `cursor_runs` row for a workflow (test-side only). */
export function readCursorRunForWorkflow(
  dbPath: string,
  workflowRunId: string,
): CursorRunDbRow | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id,
                workflow_run_id AS workflowRunId,
                agent_id AS agentId,
                run_id AS runId,
                status
         FROM cursor_runs
         WHERE workflow_run_id = ?
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(workflowRunId) as CursorRunDbRow | undefined;
  } finally {
    db.close();
  }
}

/** Point-read `workflow_runs.status` (test-side only). */
export function readWorkflowStatus(dbPath: string, workflowRunId: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const hit = db.prepare(`SELECT status FROM workflow_runs WHERE id = ?`).get(workflowRunId) as
      | { status?: string }
      | undefined;
    return hit?.status;
  } finally {
    db.close();
  }
}

/** Poll SQLite until the workflow row reaches a terminal status. */
export async function waitForWorkflowTerminalInDb(opts: {
  readonly dbPath: string;
  readonly workflowRunId: string;
  readonly timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const status = readWorkflowStatus(opts.dbPath, opts.workflowRunId);
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      return status;
    }
    await sleep(400);
  }
  throw new Error(`timed out waiting for terminal workflow status: ${opts.workflowRunId}`);
}

/** SIGTERM (then SIGKILL) a ship-cli child — matches operator Ctrl-C / OOM paths. */
export async function killShipProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveKill, reject) => {
    const hardTimer = setTimeout(() => {
      reject(new Error("timed out waiting for ship child to exit after SIGKILL"));
    }, 10_000);
    const sigkillTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }, 5000);
    child.on("close", () => {
      clearTimeout(sigkillTimer);
      clearTimeout(hardTimer);
      resolveKill();
    });
    child.on("error", (err) => {
      clearTimeout(sigkillTimer);
      clearTimeout(hardTimer);
      reject(err);
    });
  });
}

function filterEnvForStdio(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export interface RestartMcpSession {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

/**
 * Connect a long-lived MCP server against the same DB as the killed ship-cli
 * child. The first `get_workflow_run` call triggers `resumeOrphanedRuns` and
 * the stdio process stays alive until the attach pipeline settles.
 */
export async function connectRestartMcpSession(opts: {
  readonly homeRoot: string;
  readonly workflowRunId: string;
}): Promise<RestartMcpSession> {
  const env = isolatedHomeEnv(opts.homeRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx/esm", MCP_BIN],
    env: filterEnvForStdio(env),
    cwd: MCP_PKG,
  });
  const client = new Client({ name: "ship-cloud-resume-restart", version: "0.0.0" });
  await client.connect(transport);
  await client.callTool({
    name: "get_workflow_run",
    arguments: { workflowRunId: opts.workflowRunId },
  });
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Best-effort cleanup: closes the PR + deletes its branch when a PR
 * number is known; otherwise deletes the branch directly. Used by cloud
 * scenarios in `finally` so the sandbox repo doesn't accumulate dead
 * branches across runs.
 */
export function tryCleanupRemoteBranchOrPr(opts: {
  readonly owner: string;
  readonly repo: string;
  readonly prNum: number | undefined;
  readonly branch: string | undefined;
}): void {
  try {
    if (opts.prNum !== undefined) {
      execFileSync(
        "gh",
        [
          "pr",
          "close",
          String(opts.prNum),
          "--repo",
          `${opts.owner}/${opts.repo}`,
          "--delete-branch",
        ],
        { stdio: "ignore" },
      );
    } else if (opts.branch !== undefined) {
      execFileSync(
        "gh",
        ["api", "-X", "DELETE", `repos/${opts.owner}/${opts.repo}/git/refs/heads/${opts.branch}`],
        { stdio: "ignore" },
      );
    }
  } catch {
    /* best-effort cleanup */
  }
}

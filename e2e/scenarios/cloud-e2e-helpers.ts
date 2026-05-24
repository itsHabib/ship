// Shared bits for the `cloud-*.e2e.test.ts` L3 scenarios:
// `stripDotGit`, `sandboxSlugFromUrl`, the gate constant, the sandbox URL,
// best-effort cleanup, and kill/restart helpers for the resume scenario.
//
// Cloud-specific helpers (URL constant + double-gate semantics) stay here
// rather than getting promoted into the generic `live-cli-helpers.ts` —
// folding them in would widen that file's scope past CLI-driving basics.

/* eslint-disable sonarjs/no-os-command-from-path -- integration: exercises system `gh`. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { type ChildProcess, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isolatedHomeEnv, sleep } from "./live-cli-helpers.js";

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
    // 1.5s interval — light on SQLite open/close cycles while still
    // responsive enough for a multi-minute terminal-wait. Bumped from
    // 400ms per cycle-1 review (P3 — ~675 cycles over 4.5min was heavy).
    await sleep(1500);
  }
  throw new Error(`timed out waiting for terminal workflow status: ${opts.workflowRunId}`);
}

/**
 * SIGTERM (then SIGKILL fallback) a ship-cli child — matches operator Ctrl-C
 * / OOM paths. Resolves when the child has actually exited.
 *
 * IMPORTANT: do NOT gate the SIGKILL fallback on `child.killed`. Node sets
 * `killed = true` immediately after a successful `kill("SIGTERM")` call,
 * even though the process is still running. Cycle-1 review (Codex + Copilot)
 * caught this — gate on `exitCode === null` (process hasn't exited) instead.
 *
 * Also attach the close/error listeners BEFORE sending the signal, so a
 * fast-exiting child can't fire `close` between `child.kill()` and
 * `child.on("close", ...)`, leaving us waiting on the hard timer for
 * nothing.
 */
export async function killShipProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveKill, reject) => {
    const hardTimer = setTimeout(() => {
      reject(new Error("timed out waiting for ship child to exit after SIGKILL"));
    }, 10_000);
    const sigkillTimer = setTimeout(() => {
      // Only escalate if the process hasn't exited yet. `child.killed`
      // becomes true on the SIGTERM send itself, so it's NOT a reliable
      // "process is still alive" guard.
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000);
    // Attach listeners BEFORE signaling so a fast exit isn't missed.
    child.once("close", () => {
      clearTimeout(sigkillTimer);
      clearTimeout(hardTimer);
      resolveKill();
    });
    child.once("error", (err) => {
      clearTimeout(sigkillTimer);
      clearTimeout(hardTimer);
      reject(err);
    });
    child.kill("SIGTERM");
    // Defensive re-check: if the process exited synchronously between the
    // exitCode check above and the kill call, the close listener may have
    // fired already (or may have nothing left to fire on). Catch that
    // case here.
    if (child.exitCode !== null) {
      clearTimeout(sigkillTimer);
      clearTimeout(hardTimer);
      resolveKill();
    }
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
  // Defensive: strip the fake-cursor override before spawning. If the
  // operator has SHIP_TEST_FAKE_CURSOR=1 in their shell, the restarted
  // MCP server would wire FakeCursorRunner and the scenario wouldn't
  // exercise the real cloud resume path. Per cycle-1 review (Copilot).
  delete env["SHIP_TEST_FAKE_CURSOR"];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx/esm", MCP_BIN],
    env: filterEnvForStdio(env),
    cwd: MCP_PKG,
  });
  const client = new Client({ name: "ship-cloud-resume-restart", version: "0.0.0" });
  await client.connect(transport);
  // Wrap the first tool call: if it throws, close the client so the stdio
  // subprocess doesn't linger as a zombie. Without this guard, the caller's
  // `finally` block never sees a RestartMcpSession to close. Per cycle-1
  // review (Claude P2).
  try {
    await client.callTool({
      name: "get_workflow_run",
      arguments: { workflowRunId: opts.workflowRunId },
    });
  } catch (err) {
    await client.close().catch(() => {
      /* swallow secondary close error */
    });
    throw err;
  }
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

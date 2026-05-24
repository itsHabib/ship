// Shared subprocess + git helpers for live e2e scenarios that drive the
// CLI binary against a real fixture repo (test-side only). Used by the
// cloud-runtime L3 suites + the live-cancel L4 scenario.

import type { ShipOutput } from "@ship/mcp";
import type { WorkflowRun, WorkflowStatus } from "@ship/workflow";

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { startEventTailer } from "./event-tailer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIVE_SANDBOX_FIXTURE = resolve(HERE, "..", "fixtures", "live-sandbox");
export const CLI_PKG = resolve(HERE, "..", "..", "packages", "cli");
export const CLI_BIN = join(CLI_PKG, "src", "bin.ts");

export const Env = {
  cursor: process.env["CURSOR_API_KEY"] ?? "",
  github: process.env["GITHUB_TOKEN"] ?? "",
  sandbox: process.env["SHIP_E2E_SANDBOX_REPO"] ?? "",
} as const;

export function hasLiveEnv(): boolean {
  return (
    Env.cursor !== "" && Env.github !== "" && Env.sandbox !== "" && process.env["SHIP_LIVE"] === "1"
  );
}

export function parseSandboxSlug(raw: string): { owner: string; repo: string } {
  const parts = raw.split("/").filter((s) => s.length > 0);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error("SHIP_E2E_SANDBOX_REPO must be owner/repo (e.g. itsHabib/agent-sandbox)");
  }
  return { owner: parts[0], repo: parts[1] };
}

export function originHttpsUrl(token: string, slug: string): string {
  parseSandboxSlug(slug);
  return `https://x-access-token:${token}@github.com/${slug}.git`;
}

export function isolatedHomeEnv(
  homeRoot: string,
  opts?: { readonly omit?: readonly string[] },
): NodeJS.ProcessEnv {
  const omit = new Set(opts?.omit ?? []);
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (omit.has(key)) continue;
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  delete env["XDG_CONFIG_HOME"];
  env["HOME"] = homeRoot;
  env["APPDATA"] = homeRoot;
  env["USERPROFILE"] = homeRoot;
  return env;
}

export function bootstrapFixtureMainOnSandbox(opts: {
  readonly workdir: string;
  readonly token: string;
  readonly sandboxSlug: string;
}): void {
  const url = originHttpsUrl(opts.token, opts.sandboxSlug);
  cpSync(LIVE_SANDBOX_FIXTURE, opts.workdir, { recursive: true });
  runGit(opts.workdir, ["init", "-b", "main"]);
  runGit(opts.workdir, ["config", "user.email", "ship-l4@example.com"]);
  runGit(opts.workdir, ["config", "user.name", "Ship L4"]);
  runGit(opts.workdir, ["add", "."]);
  runGit(opts.workdir, ["commit", "-m", "fixture: live sandbox"]);
  runGit(opts.workdir, ["remote", "add", "origin", url]);
  runGit(opts.workdir, ["push", "-u", "origin", "main", "--force"]);
  runGit(opts.workdir, ["remote", "set-head", "origin", "main"]);
}

function runGit(cwd: string, args: string[]): void {
  /* eslint-disable sonarjs/no-os-command-from-path -- integration-style git against user PATH */
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  /* eslint-enable sonarjs/no-os-command-from-path */
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (status ${String(r.status)}): ${r.stderr}`);
  }
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(
  homeRoot: string,
  args: readonly string[],
  opts?: { readonly omitEnv?: readonly string[] },
): Promise<CliResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", CLI_BIN, ...args], {
      cwd: CLI_PKG,
      env:
        opts?.omitEnv !== undefined
          ? isolatedHomeEnv(homeRoot, { omit: opts.omitEnv })
          : isolatedHomeEnv(homeRoot),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

export function runCliSync(
  homeRoot: string,
  args: readonly string[],
  opts?: { readonly omitEnv?: readonly string[] },
): CliResult {
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", CLI_BIN, ...args], {
    cwd: CLI_PKG,
    env:
      opts?.omitEnv !== undefined
        ? isolatedHomeEnv(homeRoot, { omit: opts.omitEnv })
        : isolatedHomeEnv(homeRoot),
    encoding: "utf-8",
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

export function parseListRuns(stdout: string): { runs: WorkflowRun[] } {
  return JSON.parse(stdout.trim()) as { runs: WorkflowRun[] };
}

export function parseWorkflowRun(stdout: string): WorkflowRun {
  return JSON.parse(stdout.trim()) as WorkflowRun;
}

export function mkLiveTmp(prefix: string): { root: string; workdir: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, workdir: join(root, "wt") };
}

/** Resolves the newest workflow id for `repo` once SQLite reflects the row (running, pending, or already terminal). */
export async function waitForWorkflowRowId(homeRoot: string, repoLabel: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const r = runCliSync(homeRoot, ["list", "--repo", repoLabel, "--json"]);
    if (r.code === 0) {
      const body = parseListRuns(r.stdout);
      const first = body.runs[0];
      if (first !== undefined) return first.id;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for workflow row (repo=${repoLabel})`);
}

export async function pollUntilTerminal(
  homeRoot: string,
  workflowRunId: string,
): Promise<WorkflowRun> {
  const terminal: ReadonlySet<WorkflowStatus> = new Set(["succeeded", "failed", "cancelled"]);
  // Deadline below vitest's 5-min testTimeout so we throw a clean
  // "timed out waiting for terminal status" before the test runner kills us.
  const deadline = Date.now() + 4.5 * 60_000;
  while (Date.now() < deadline) {
    const r = runCliSync(homeRoot, ["status", workflowRunId, "--json"]);
    if (r.code !== 0) {
      await sleep(400);
      continue;
    }
    const run = parseWorkflowRun(r.stdout);
    if (terminal.has(run.status)) return run;
    await sleep(400);
  }
  throw new Error(`timed out waiting for terminal status: ${workflowRunId}`);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

export interface ShipChildHandle {
  readonly child: ChildProcess;
  readonly waitForClose: () => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  readonly stop: () => void;
}

export interface SpawnShipArgs {
  readonly homeRoot: string;
  readonly workdir: string;
  readonly repoLabel: string;
  readonly branch: string;
  readonly docRel: string;
}

// Spawns `ship` against the CLI binary with a per-scenario isolated home
// tree, a streaming event-tailer for human visibility, and a captured
// stdout buffer for the post-run JSON parse. Returns a handle the caller
// drives (close-the-child, stop-the-tailer).
export function spawnShipChild(args: SpawnShipArgs): ShipChildHandle {
  const env = isolatedHomeEnv(args.homeRoot);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      CLI_BIN,
      "ship",
      args.docRel,
      "--workdir",
      args.workdir,
      "--repo",
      args.repoLabel,
      "--branch",
      args.branch,
      "--json",
      "--model-param",
      "fast=false",
    ],
    {
      cwd: CLI_PKG,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (c: string) => {
    stdout += c;
    process.stdout.write(c);
  });
  child.stderr.on("data", (c: string) => {
    process.stderr.write(`[ship-stderr] ${c}`);
  });
  const tailer = startEventTailer(args.homeRoot, child);
  // Eagerly register the close listener — the child may exit before
  // `waitForClose()` is called (notably when the caller awaits
  // workflow-terminal status separately, which means the child has
  // already exited and the `close` event has already fired). Lazy
  // registration would attach a listener after-the-fact and hang forever.
  const closePromise = new Promise<{ readonly exitCode: number; readonly stdout: string }>(
    (res) => {
      child.on("close", (c) => {
        res({ exitCode: c ?? -1, stdout });
      });
    },
  );
  return {
    child,
    waitForClose: () => closePromise,
    stop: () => {
      tailer.stop();
    },
  };
}

// Convenience wrapper: spawn ship, wait for close, assert exit 0 +
// `status: succeeded`, return parsed output. Callers that need to poll
// terminal state separately, or cancel mid-flight, use spawnShipChild
// directly instead.
export async function runShipExpectingSuccess(
  args: SpawnShipArgs,
): Promise<{ readonly workflowRunId: string; readonly output: ShipOutput }> {
  const s = spawnShipChild(args);
  try {
    const { exitCode, stdout } = await s.waitForClose();
    expect(exitCode).toBe(0);
    const shipped = JSON.parse(stdout.trim()) as ShipOutput;
    expect(shipped.status).toBe("succeeded");
    return { workflowRunId: shipped.workflowRunId, output: shipped };
  } finally {
    s.stop();
  }
}

// Event-driven gate for cancellation — assistant / tool traffic only.
export function ndjsonSuggestsAgentStarted(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  try {
    const o = JSON.parse(t) as { type?: string };
    if (o.type === "assistant") return true;
    if (o.type === "tool_use" || o.type === "tool_call" || o.type === "tool_result") return true;
    return false;
  } catch {
    return false;
  }
}

export async function waitForEventsNdjsonPredicate(opts: {
  readonly homeRoot: string;
  readonly predicate: (absPath: string, content: string) => boolean;
  readonly timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const p = findEventsNdjsonUnderHome(opts.homeRoot);
    if (p !== undefined) {
      let content: string;
      try {
        content = readFileSync(p, "utf-8");
      } catch {
        content = "";
      }
      if (opts.predicate(p, content)) return p;
    }
    await sleep(250);
  }
  throw new Error("timed out waiting for events.ndjson predicate");
}

function findEventsNdjsonUnderHome(homeRoot: string): string | undefined {
  const candidates = [
    join(homeRoot, ".config", "ship", "runs"),
    join(homeRoot, "AppData", "Roaming", "ship", "runs"),
  ];
  for (const c of candidates) {
    const hit = walkForEventsNdjson(c);
    if (hit !== undefined) return hit;
  }
  return walkForEventsNdjson(homeRoot);
}

function walkForEventsNdjson(root: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const n of names) {
    const hit = visitEventsCandidate(join(root, n), n);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function visitEventsCandidate(absPath: string, name: string): string | undefined {
  try {
    const st = statSync(absPath);
    if (!st.isDirectory()) {
      return name === "events.ndjson" ? absPath : undefined;
    }
    return walkForEventsNdjson(absPath);
  } catch {
    return undefined;
  }
}

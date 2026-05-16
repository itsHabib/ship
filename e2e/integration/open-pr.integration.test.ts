/* eslint-disable
   no-param-reassign,
   sonarjs/no-os-command-from-path,
   @typescript-eslint/no-shadow
   -- integration test shells out to system `git` (fine in a test env),
   mutates node:http response objects in the mock server (standard
   pattern with no API alternative), and shadows the outer Promise
   `resolve` inside nested executors (no semantic conflict). */
// Subprocess-level integration test for `open_pr` via the
// `@ship/mcp-server` binary. Spawns `tsx src/bin.ts`, connects an
// MCP `Client`, seeds a workflow run in the real on-disk SQLite,
// stands up a localhost HTTP server pretending to be GitHub
// (Octokit's `SHIP_OCTOKIT_BASE_URL` env var points at it), and
// drives the `open_pr` tool end-to-end. The same flow tests the
// idempotent branch (second `open_pr` against the same run).

import type { OpenPrOutput } from "@ship/mcp";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const PKG = resolve(HERE, "..", "..", "packages", "mcp-server");
const BIN = join(PKG, "src", "bin.ts");

// Repo init helper. The integration test stands up a real git repo
// on disk so the `GitRemote` shell-outs (origin URL parse,
// default-branch probe, push) hit real git. The recorded `origin` is
// a fake `https://github.com/test/test.git` URL so `readOriginRepo`
// parses owner/repo correctly; `url.<bare>.insteadOf` rewrites that
// at push time to a local bare repo so we don't need network.
function initGitRepo(workdir: string, originBarePath: string): void {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(originBarePath, { recursive: true });
  const fakeOriginUrl = "https://github.com/test/test.git";
  execFileSync("git", ["init", "--bare", "--initial-branch=main", originBarePath]);
  execFileSync("git", ["init", "--initial-branch=main", workdir]);
  execFileSync("git", ["-C", workdir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", workdir, "config", "user.name", "Test"]);
  // Rewrite pushes to the fake URL → the on-disk bare repo. Using
  // `pushInsteadOf` (not `insteadOf`) so fetch/clone paths still see
  // the github.com URL and only pushes get redirected.
  execFileSync("git", [
    "-C",
    workdir,
    "config",
    `url.${originBarePath.replace(/\\/g, "/")}.pushInsteadOf`,
    fakeOriginUrl,
  ]);
  writeFileSync(join(workdir, "README.md"), "base\n");
  execFileSync("git", ["-C", workdir, "add", "README.md"]);
  execFileSync("git", ["-C", workdir, "commit", "-m", "base"]);
  execFileSync("git", ["-C", workdir, "remote", "add", "origin", fakeOriginUrl]);
  // Push the base branch to the bare repo via the rewrite.
  execFileSync("git", ["-C", workdir, "push", "-u", "origin", "main"]);
  execFileSync("git", ["-C", originBarePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
  // Create the feature branch + a commit on it (don't push yet — the
  // open_pr flow does the push).
  execFileSync("git", ["-C", workdir, "checkout", "-b", "tower/feat"]);
  writeFileSync(join(workdir, "feature.txt"), "feature\n");
  execFileSync("git", ["-C", workdir, "add", "feature.txt"]);
  execFileSync("git", ["-C", workdir, "commit", "-m", "feat: hello"]);
  // Pre-warm origin/HEAD so `readDefaultBranch`'s symbolic-ref probe
  // resolves without falling back to `remote show origin`.
  // Use --no-query: the rewrite redirects this to the bare repo and
  // its remote `HEAD` was symref'd to refs/heads/main above.
  execFileSync("git", ["-C", workdir, "remote", "set-head", "origin", "main"]);
}

// Inserts a workflow_runs row + a succeeded implement phase row so
// `open_pr` clears its preconditions. Called AFTER the mcp-server
// child has connected (its migration already ran), so we don't fight
// the table creation. WAL lets the secondary connection coexist with
// the server's open handle without write contention.
function seedWorkflowRow(dbPath: string, workflowRunId: string, workdir: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const now = new Date().toISOString();
    const worktree = JSON.stringify({
      repo: "test",
      name: "feat",
      branch: "tower/feat",
      path: workdir,
      baseRef: "main",
    });
    const policy = JSON.stringify({
      baseRef: "main",
      maxRunDurationMs: 30 * 60 * 1000,
      agentTimeoutMs: 30 * 60 * 1000,
    });
    db.prepare(
      `INSERT INTO workflow_runs (id, repo, doc_path, status, base_ref, worktree_json, policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowRunId, "test", "docs/feat.md", "succeeded", "main", worktree, policy, now, now);
    db.prepare(
      `INSERT INTO phases (id, workflow_run_id, kind, status, input_json, created_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ph_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workflowRunId,
      "implement",
      "succeeded",
      JSON.stringify({ docPath: "docs/feat.md" }),
      now,
      now,
      now,
    );
  } finally {
    db.close();
  }
}

interface MockServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly state: {
    listOpenResponse: unknown[];
    createResponse: { number: number; html_url: string };
    createCalls: { body: string; url: string }[];
  };
}

async function startMockGitHub(): Promise<MockServer> {
  const state: MockServer["state"] = {
    listOpenResponse: [],
    createResponse: { number: 100, html_url: "https://github.com/test/test/pull/100" },
    createCalls: [],
  };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const method = req.method?.toUpperCase() ?? "GET";
    if (method === "GET" && url.includes("/pulls")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state.listOpenResponse));
      return;
    }
    if (method === "POST" && url.includes("/pulls")) {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        state.createCalls.push({ body, url });
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(state.createResponse));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "no route" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  return {
    baseUrl,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

let mock: MockServer;

beforeAll(async () => {
  mock = await startMockGitHub();
});

afterAll(async () => {
  await mock.close();
});

interface ChildEnv {
  readonly tmp: string;
  readonly dbPath: string;
  readonly runsDir: string;
  readonly workdir: string;
  readonly env: NodeJS.ProcessEnv;
}

function buildChildEnv(): ChildEnv {
  const tmp = mkdtempSync(join(tmpdir(), "ship-open-pr-int-"));
  const dbPath = join(tmp, "state.db");
  const runsDir = join(tmp, "runs");
  const workdir = join(tmp, "work");
  const originBare = join(tmp, "origin.git");
  initGitRepo(workdir, originBare);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["XDG_CONFIG_HOME"];
  env["HOME"] = tmp;
  env["APPDATA"] = tmp;
  env["USERPROFILE"] = tmp;
  env["SHIP_TEST_FAKE_CURSOR"] = "1";
  env["SHIP_DB_PATH"] = dbPath;
  env["SHIP_RUNS_DIR"] = runsDir;
  env["GITHUB_TOKEN"] = "ghp_integration_test";
  env["SHIP_OCTOKIT_BASE_URL"] = mock.baseUrl;
  return { tmp, dbPath, runsDir, workdir, env };
}

function filterEnvForStdio(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
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

let cenv: ChildEnv;
let client: Client;
let transport: StdioClientTransport;
// Canonical-ULID alphabet excludes I/L/O/U — use a valid sample.
const WF_ID = "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV";

beforeEach(async () => {
  cenv = buildChildEnv();
  // Reset mock state per test so prior asserts don't leak.
  mock.state.listOpenResponse = [];
  mock.state.createResponse = { number: 100, html_url: "https://github.com/test/test/pull/100" };
  mock.state.createCalls = [];

  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx/esm", BIN],
    env: filterEnvForStdio(cenv.env),
    cwd: PKG,
  });
  client = new Client({ name: "ship-open-pr-int-client", version: "0.0.0" });
  await client.connect(transport);
  // list_workflow_runs forces the lazy service factory to construct
  // the store (which runs the SQLite migration) before we open a
  // second handle to seed rows. `listTools` alone doesn't trigger
  // construction — the SDK only enumerates registered tools.
  await client.callTool({ name: "list_workflow_runs", arguments: {} });
  seedWorkflowRow(cenv.dbPath, WF_ID, cenv.workdir);
});

afterEach(async () => {
  await client.close();
});

describe("open_pr tool — subprocess integration", () => {
  test("happy path: pushes branch, creates PR via Octokit, returns the documented shape", async () => {
    const raw = await client.callTool({
      name: "open_pr",
      arguments: { workflowRunId: WF_ID },
    });
    const out = parseToolJson(raw) as OpenPrOutput;
    expect(out.status).toBe("succeeded");
    expect(out.alreadyExisted).toBe(false);
    expect(out.prNumber).toBe(100);
    expect(out.prUrl).toBe("https://github.com/test/test/pull/100");
    expect(out.base).toBe("main");
    expect(out.head).toBe("tower/feat");
    // The mock server saw exactly one POST.
    expect(mock.state.createCalls).toHaveLength(1);
  });

  test("idempotent re-open: pre-seeded open PR → alreadyExisted=true, no second create", async () => {
    mock.state.listOpenResponse = [
      { number: 42, html_url: "https://github.com/test/test/pull/42" },
    ];
    const raw = await client.callTool({
      name: "open_pr",
      arguments: { workflowRunId: WF_ID },
    });
    const out = parseToolJson(raw) as OpenPrOutput;
    expect(out.alreadyExisted).toBe(true);
    expect(out.prNumber).toBe(42);
    expect(mock.state.createCalls).toHaveLength(0);
  });
});

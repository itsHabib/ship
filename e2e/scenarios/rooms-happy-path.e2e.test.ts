/**
 * L3 live e2e — rooms runtime happy path (self-hosted microVM).
 *
 * Drives the `ship` MCP tool with `runtime: "rooms"` against a real
 * Firecracker microVM on the rooms-host, reads the pushed branch back via
 * `get_workflow_run`, and asserts the agent's change reached the remote
 * branch (read-only compare API). The room pushes the branch; opening a PR is
 * downstream of ship (ED-3), so the PR-open is exercised only when the token
 * carries pull-requests:write and otherwise logs a skip — the rooms-loop
 * assertions never depend on it.
 *
 * Unlike the cloud scenarios (which drive the CLI binary), rooms is reachable
 * only through the MCP `ship` tool — the CLI exposes no `--room-*` flags by
 * design — so this scenario speaks MCP stdio directly. That also mirrors the
 * contract the L3 gate names: `ship { runtime: "rooms" }` ->
 * `get_workflow_run` -> `branches[0].branch`.
 *
 * Gated on SHIP_LIVE=1 + SHIP_ROOMS=1 + CURSOR_API_KEY + GITHUB_TOKEN (or
 * GH_TOKEN) + SHIP_ROOMS_IMAGE (absolute guest-image path on the host). The
 * host must also have the `rooms` binary on PATH, /dev/kvm + Firecracker, the
 * guest SSH identity at `$HOME/.ssh/id_rooms`, and `gh`.
 *
 * IMPORTANT: HOME is NOT isolated here. `rooms` resolves the guest SSH
 * identity from `$HOME/.ssh/id_rooms`; the cloud-harness HOME-isolation trick
 * would break guest reachability. Ship's own state is isolated via
 * SHIP_DB_PATH / SHIP_RUNS_DIR instead.
 */

/* eslint-disable sonarjs/no-os-command-from-path -- integration: exercises system `gh`. */

import type { GetWorkflowRunOutput, ShipStartOutput } from "@ship/mcp";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  sandboxSlugFromUrl,
  stripDotGit,
  tryCleanupRemoteBranchOrPr,
} from "./cloud-e2e-helpers.js";
import { sleep } from "./live-cli-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_PKG = resolve(HERE, "..", "..", "packages", "mcp-server");
const MCP_BIN = join(MCP_PKG, "src", "bin.ts");

// `.trim()` is load-bearing: a token sourced from a CRLF-edited shell rc
// carries a trailing CR. `git push` tolerates it (the in-guest push works),
// but `gh`'s Go HTTP client rejects it as an invalid Authorization header
// value. Trimming keeps the gate robust regardless of host env hygiene.
const GITHUB_TOKEN = (process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "").trim();
const ROOMS_IMAGE = process.env["SHIP_ROOMS_IMAGE"] ?? "";
const ROOMS_SANDBOX_REPO = stripDotGit(
  process.env["SHIP_ROOMS_SANDBOX_REPO"] ?? "https://github.com/itsHabib/agent-sandbox",
);

/**
 * True only when every input the rooms scenario needs is present. The guest
 * push uses GH_TOKEN, and `gh` PR creation needs the token too, so it's part
 * of the gate — a missing token should `skipIf`-skip, not fail with a
 * confusing auth error. SHIP_ROOMS_IMAGE is the absolute guest-image path on
 * the host; without it the rooms CLI has nothing to boot.
 */
const HAS_KEY_AND_ROOMS =
  process.env["SHIP_LIVE"] === "1" &&
  process.env["SHIP_ROOMS"] === "1" &&
  (process.env["CURSOR_API_KEY"] ?? "") !== "" &&
  GITHUB_TOKEN !== "" &&
  ROOMS_IMAGE !== "";

// Real HOME (rooms needs $HOME/.ssh/id_rooms); isolate only ship's state.
function roomsMcpEnv(homeRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  // A stray fake-cursor override would wire FakeCursorRunner and skip the
  // real microVM path entirely — strip it defensively.
  delete env["SHIP_TEST_FAKE_CURSOR"];
  env["SHIP_DB_PATH"] = join(homeRoot, "state.db");
  env["SHIP_RUNS_DIR"] = join(homeRoot, "runs");
  // The in-guest push reads GH_TOKEN; force the trimmed token so the push
  // never inherits a CR-tailed value from the parent env.
  env["GH_TOKEN"] = GITHUB_TOKEN;
  return env;
}

// Env for `gh` shell-outs: the trimmed token on both names, over a copy of
// process.env (which may carry a CR-tailed GH_TOKEN that gh would reject).
function ghEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GH_TOKEN: GITHUB_TOKEN, GITHUB_TOKEN };
}

function parseToolJson(res: unknown): unknown {
  const content = (res as { content?: readonly { type: string; text?: string }[] }).content;
  const first = content?.[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error(`unexpected MCP tool result shape: ${JSON.stringify(res)}`);
  }
  return JSON.parse(first.text);
}

async function pollWorkflowTerminal(
  client: Client,
  workflowRunId: string,
  timeoutMs: number,
): Promise<GetWorkflowRunOutput> {
  const terminal = new Set(["succeeded", "failed", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = parseToolJson(
      await client.callTool({ name: "get_workflow_run", arguments: { workflowRunId } }),
    ) as GetWorkflowRunOutput;
    if (terminal.has(run.status)) return run;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for terminal status: ${workflowRunId}`);
}

function pullNumberFromPrUrl(prUrl: string): number {
  const m = /\/pull\/(\d+)\b/.exec(prUrl);
  if (m?.[1] === undefined) throw new Error(`could not parse PR number from: ${prUrl}`);
  return Number(m[1]);
}

// Open a PR from `head`, returning its URL. Returns undefined (not throws)
// when the token lacks pull-requests:write — the rooms-loop assertions don't
// depend on PR creation, so a contents-only e2e token shouldn't fail the gate.
function tryCreatePr(
  slug: string,
  head: string,
  marker: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  try {
    return execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        slug,
        "--base",
        "main",
        "--head",
        head,
        "--title",
        `rooms L3 e2e: ${head}`,
        "--body",
        `Automated rooms-backend L3 e2e. Marker: ${marker}`,
      ],
      { encoding: "utf-8", env },
    ).trim();
  } catch (err) {
    if (/not accessible|pull request create failed/i.test(String(err))) return undefined;
    throw err;
  }
}

describe.skipIf(!HAS_KEY_AND_ROOMS)("L3 rooms e2e — happy path (self-hosted microVM)", () => {
  test("ship {runtime:rooms} pushes a branch; get_workflow_run surfaces it; branch carries the change", async () => {
    const slug = sandboxSlugFromUrl(ROOMS_SANDBOX_REPO);
    const [owner, repo] = slug.split("/");
    if (owner === undefined || repo === undefined) throw new Error(`bad sandbox slug: ${slug}`);
    const hex = randomBytes(4).toString("hex");
    const marker = `rooms-l3 marker ${hex}`;
    const pushBranch = `rooms/e2e-l3-${hex}`;

    const homeRoot = mkdtempSync(join(tmpdir(), "ship-rooms-l3-"));
    const workdir = join(homeRoot, "wt");
    mkdirSync(workdir, { recursive: true });
    // The doc content becomes the agent's task (rooms writes it to task.md in
    // the guest). A deterministic single-line append keeps the PR diff exact.
    writeFileSync(
      join(workdir, "task.md"),
      `# Task\n\nAppend exactly one new line containing the text "${marker}" to the bottom ` +
        `of README.md. Do not modify any other file. Keep the change to a single one-line append.\n`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx/esm", MCP_BIN],
      env: roomsMcpEnv(homeRoot),
      cwd: MCP_PKG,
    });
    const client = new Client({ name: "ship-rooms-l3", version: "0.0.0" });
    await client.connect(transport);

    let prNum: number | undefined;
    let branchForCleanup: string | undefined;
    try {
      const started = parseToolJson(
        await client.callTool({
          name: "ship",
          arguments: {
            workdir,
            docPath: "task.md",
            runtime: "rooms",
            room: { repos: [{ url: ROOMS_SANDBOX_REPO }], image: ROOMS_IMAGE, pushBranch },
          },
        }),
      ) as ShipStartOutput;
      expect(started.status).toBe("running");

      const run = await pollWorkflowTerminal(client, started.workflowRunId, 4.5 * 60_000);
      const diag = `status=${run.status} branches=${JSON.stringify(run.branches ?? null)} failureCategory=${JSON.stringify(run.failureCategory ?? null)}`;
      expect(run.status, diag).toBe("succeeded");
      expect((run.branches ?? []).length, diag).toBeGreaterThan(0);
      const b0 = run.branches![0]!;
      expect(b0.branch, diag).toBe(pushBranch);
      expect(b0.repoUrl).toBe(ROOMS_SANDBOX_REPO);
      branchForCleanup = b0.branch;

      // ship pushes the branch; opening a PR is downstream (ED-3). Assert the
      // agent's change reached the remote branch via the read-only compare
      // API — a contents-scoped token proves the rooms loop produced the edit
      // independent of PR-create permissions.
      const compare = JSON.parse(
        execFileSync("gh", ["api", `repos/${owner}/${repo}/compare/main...${pushBranch}`], {
          encoding: "utf-8",
          env: ghEnv(),
        }),
      ) as { files?: { filename: string; patch?: string }[] };
      const changed = (compare.files ?? []).find((f) => f.filename === "README.md");
      expect(
        changed,
        `compare files: ${JSON.stringify((compare.files ?? []).map((f) => f.filename))}`,
      ).toBeDefined();
      expect(changed!.patch ?? "").toContain(marker);

      // Exercise the downstream PR-open when the token allows it. PR creation
      // needs pull-requests:write; a contents-only token downgrades this to a
      // logged skip (the change is already proven on the branch above).
      const prUrl = tryCreatePr(slug, pushBranch, marker, ghEnv());
      if (prUrl === undefined) {
        process.stderr.write(
          `[rooms-l3] PR create skipped — token lacks pull-requests:write on ${slug}\n`,
        );
      } else {
        expect(prUrl).toMatch(/\/pull\/\d+/);
        prNum = pullNumberFromPrUrl(prUrl);
      }
    } finally {
      await client.close().catch(() => {
        /* swallow secondary close error */
      });
      tryCleanupRemoteBranchOrPr({ owner, repo, prNum, branch: branchForCleanup });
    }
  });
});

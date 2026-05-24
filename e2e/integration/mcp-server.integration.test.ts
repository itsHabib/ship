/**
 * Subprocess-level integration test for the `@ship/mcp-server` binary.
 * Spawns `tsx src/bin.ts` via `StdioClientTransport`, connects a real
 * MCP `Client`, and exercises each V1 tool + the runs resource end-to-
 * end (real stdio, real subprocess, real SQLite on disk; the cursor
 * runtime is faked via `SHIP_TEST_FAKE_CURSOR=1` so we don't need an
 * API key).
 *
 * Mirrors `cli-binary.integration.test.ts`'s pattern (Phase 7) so both
 * binaries get the same "real subprocess" smoke coverage. This is the
 * layer that catches stdio framing / capability-declaration bugs the
 * in-memory tests miss.
 */

import type { ListWorkflowRunsOutput, ShipStartOutput } from "@ship/mcp";
import type { WorkflowRun } from "@ship/workflow";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { waitForTerminalRun } from "@ship/test-harness";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..", "..", "packages", "mcp-server");
const BIN = join(PKG, "src", "bin.ts");

interface ChildEnv {
  readonly tmp: string;
  readonly dbPath: string;
  readonly runsDir: string;
  readonly workdir: string;
  readonly env: NodeJS.ProcessEnv;
}

function buildChildEnv(): ChildEnv {
  const tmp = mkdtempSync(join(tmpdir(), "ship-mcp-int-"));
  const dbPath = join(tmp, "state.db");
  const runsDir = join(tmp, "runs");
  const workdir = join(tmp, "work");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "docs.md"), "# Integration test\n\nDo it.\n");

  // Clone process.env minus the keys that resolve to the user's real
  // config dir (same isolation as the CLI integration suite).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["XDG_CONFIG_HOME"];
  env["HOME"] = tmp;
  env["APPDATA"] = tmp;
  env["USERPROFILE"] = tmp;
  env["SHIP_TEST_FAKE_CURSOR"] = "1";
  env["SHIP_DB_PATH"] = dbPath;
  env["SHIP_RUNS_DIR"] = runsDir;

  return { tmp, dbPath, runsDir, workdir, env };
}

let cenv: ChildEnv;
let client: Client;
let transport: StdioClientTransport;

beforeEach(async () => {
  cenv = buildChildEnv();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx/esm", BIN],
    env: filterEnvForStdio(cenv.env),
    cwd: PKG,
  });
  client = new Client({ name: "ship-mcp-int-client", version: "0.0.0" });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
  // `transport.close()` is implicitly handled by `client.close`.
});

describe("ship-mcp-server binary — subprocess smoke", () => {
  test("listTools returns every registered tool", async () => {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual([
      "cancel_workflow_run",
      "get_workflow_run",
      "list_workflow_runs",
      "ship",
    ]);
  });

  test("listResourceTemplates returns the ship://runs/{id} template", async () => {
    const list = await client.listResourceTemplates();
    const names = list.resourceTemplates.map((r) => r.name);
    expect(names).toContain("ship-run");
  });

  test("list_workflow_runs against a fresh store returns { runs: [] }", async () => {
    const raw = await client.callTool({ name: "list_workflow_runs", arguments: {} });
    const out = parseToolJson(raw) as ListWorkflowRunsOutput;
    expect(out.runs).toEqual([]);
  });

  test("ship returns the V2 async start shape in well under 1s wall-clock", async () => {
    // V2 acceptance criterion (docs/features/ship-v2/phases/01-async-ship-tool.md
    // § Validation plan): the MCP `ship` tool returns `{ workflowRunId,
    // status: "running" }` within < 1s, even when the underlying run
    // would take longer. This subprocess-level test is what guards the
    // contract against accidental regression to the V1 blocking shape.
    // Monotonic clock — `Date.now()` is wall-clock and can jump under
    // NTP / time sync, which would make a "< 1s" budget assertion
    // flaky (or even produce a negative elapsed).
    const before = performance.now();
    const shippedRaw = await client.callTool({
      name: "ship",
      arguments: { workdir: cenv.workdir, repo: "ship", docPath: "docs.md" },
    });
    const elapsed = performance.now() - before;
    const shipped = parseToolJson(shippedRaw) as ShipStartOutput;

    expect(shipped.status).toBe("running");
    expect(shipped.workflowRunId).toMatch(/^wf_/);
    expect(elapsed).toBeLessThan(1000);

    // `shipStartOutputSchema` is `.strict()`, so the wire payload is
    // exactly `{ workflowRunId, status }` — no leaked V1 fields.
    expect(Object.keys(shipped).sort((a, b) => a.localeCompare(b))).toEqual([
      "status",
      "workflowRunId",
    ]);

    const terminal = await waitForTerminalRun(client, shipped.workflowRunId, INT_POLL);
    expect(terminal.status).toBe("succeeded");
  });

  test("ship + read resource round-trip lands artifacts on real disk", async () => {
    const shippedRaw = await client.callTool({
      name: "ship",
      arguments: { workdir: cenv.workdir, repo: "ship", docPath: "docs.md" },
    });
    const shipped = parseToolJson(shippedRaw) as ShipStartOutput;
    expect(shipped.status).toBe("running");

    // Poll until terminal so the resource read sees the final
    // hydrated row.
    const terminal = await waitForTerminalRun(client, shipped.workflowRunId, INT_POLL);
    expect(terminal.status).toBe("succeeded");
    // The implement phase carries an FK to the cursor-run row that
    // was recorded after the runner returned; presence is the
    // load-bearing check that the post-runner store writes ran.
    const cursorRunPhase = terminal.phases[0];
    expect(cursorRunPhase?.cursorRunId).toBeDefined();
    // V1 also asserted the wiring-default model params propagated to
    // `shipped.cursorRun.model`. V2's MCP `ship` response no longer
    // surfaces `CursorRunRef`, and `WorkflowRun` only carries the phase
    // row's FK — not the embedded ref. Coverage for the model-resolver
    // path lives at the unit level (`packages/core/src/service.test.ts`).

    const got = await client.readResource({ uri: `ship://runs/${shipped.workflowRunId}` });
    const block = got.contents[0];
    expect(block?.mimeType).toBe("application/json");
    if (block === undefined || !("text" in block)) {
      throw new Error(`expected text content block, got: ${JSON.stringify(block)}`);
    }
    const run = JSON.parse(block.text) as WorkflowRun;
    expect(run.id).toBe(shipped.workflowRunId);
    expect(run.status).toBe("succeeded");
  });

  test("ship with explicit modelParams still reaches persistence on the fake runner", async () => {
    const shippedRaw = await client.callTool({
      name: "ship",
      arguments: {
        workdir: cenv.workdir,
        repo: "ship",
        docPath: "docs.md",
        modelParams: [{ id: "fast", value: false }],
      },
    });
    const shipped = parseToolJson(shippedRaw) as ShipStartOutput;
    expect(shipped.status).toBe("running");

    // Same V2 caveat as above — the model assertion that used to live
    // here on `shipped.cursorRun.model` isn't reachable through the
    // V2 MCP surface. The override-resolver path is unit-tested in
    // `packages/core/src/service.test.ts`.
    const terminal = await waitForTerminalRun(client, shipped.workflowRunId, INT_POLL);
    expect(terminal.status).toBe("succeeded");
  });
});

describe("ship-mcp-server binary — pre-flight", () => {
  test("missing CURSOR_API_KEY (without SHIP_TEST_FAKE_CURSOR) → exit 1 with stderr message", () => {
    const env = sanitizedPreflightEnv();
    delete env["CURSOR_API_KEY"];

    const result = spawnSync(process.execPath, ["--import", "tsx/esm", BIN], {
      encoding: "utf-8",
      cwd: PKG,
      env,
      timeout: 5_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/CURSOR_API_KEY/);
  });

  test("empty CURSOR_API_KEY is treated as missing → exit 1 (cycle-1 review fix)", () => {
    const env = sanitizedPreflightEnv();
    env["CURSOR_API_KEY"] = "";

    const result = spawnSync(process.execPath, ["--import", "tsx/esm", BIN], {
      encoding: "utf-8",
      cwd: PKG,
      env,
      timeout: 5_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/CURSOR_API_KEY/);
  });
});

/**
 * Builds a child env scoped to the per-test tmp + stripped of
 * `XDG_CONFIG_HOME` / `SHIP_TEST_FAKE_CURSOR` so the preflight path
 * runs without interference. Caller still chooses what (if anything)
 * to set on `CURSOR_API_KEY`.
 */
function sanitizedPreflightEnv(): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["XDG_CONFIG_HOME"];
  delete env["SHIP_TEST_FAKE_CURSOR"];
  env["HOME"] = cenv.tmp;
  env["APPDATA"] = cenv.tmp;
  env["USERPROFILE"] = cenv.tmp;
  return filterEnvForStdio(env);
}

/**
 * Strips `undefined` values so the stdio transport's env-passing path
 * gets a `Record<string, string>` (its types reject `undefined`).
 */
function filterEnvForStdio(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Same shape as `parseToolJson` from the unit-test harness; duplicated
 * here so the integration suite doesn't dep on `@ship/mcp-server`'s
 * `test/` dir directly. Throws on `isError: true`. Returns `unknown`
 * so the caller can cast to the expected schema's inferred type.
 */
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

// Wider poll budget than the in-process unit harness defaults
// (200 × 10ms = 2s). The fake-cursor child can be slow to settle on a
// busy CI box; 300 × 50ms = 15s gives subprocess-mode tests enough
// headroom without masking a real hang.
const INT_POLL = { maxAttempts: 300, intervalMs: 50 } as const;

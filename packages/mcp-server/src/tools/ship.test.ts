/**
 * `ship` tool tests — happy path + each error path. Uses the
 * in-memory MCP harness (test/mcp-harness.ts) so the request/response
 * dispatch path runs through the actual SDK, not direct method calls.
 *
 * V2: the tool returns `{ workflowRunId, status: "running" }` once the
 * row + initial phase row are persisted. Tests that need terminal
 * state poll via `waitForTerminalRun`.
 */

import type { ShipStartOutput } from "@ship/mcp";

import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createMcpHarness,
  expectToolError,
  type McpHarness,
  parseToolJson,
  TEST_DOC_PATH,
  TEST_WORKDIR,
  waitForTerminalRun,
} from "../../test/mcp-harness.js";

let h: McpHarness;

beforeEach(async () => {
  h = await createMcpHarness();
});

afterEach(async () => {
  await h.close();
});

describe("ship tool", () => {
  test("returns the async start shape immediately; background continuation reaches terminal", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, summary: "shipped", branches: [] },
    });

    // Monotonic clock — `Date.now()` can jump under NTP and trip the
    // "< 1s" timing budget below with a negative or stale delta.
    const before = performance.now();
    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: TEST_DOC_PATH },
    });
    const elapsed = performance.now() - before;
    const start = parseToolJson(raw) as ShipStartOutput;

    // V2 contract: immediate return with `{ workflowRunId, status: "running" }`.
    expect(start.status).toBe("running");
    expect(start.workflowRunId).toMatch(/^wf_/);
    // Generous bound — the in-memory transport + fake cursor make
    // this trivially fast in practice. The integration test asserts
    // the real < 1s budget through the subprocess.
    expect(elapsed).toBeLessThan(1000);

    const terminal = await waitForTerminalRun(h.client, start.workflowRunId);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.phases).toHaveLength(1);
    expect(terminal.phases[0]?.status).toBe("succeeded");
  });

  test("returns the start shape strictly (extra fields would fail the boundary schema)", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: TEST_DOC_PATH },
    });
    const start = parseToolJson(raw) as ShipStartOutput;
    // `shipStartOutputSchema` is `.strict()` + `z.literal("running")`,
    // so the wire payload has exactly these two keys.
    expect(Object.keys(start).sort((a, b) => a.localeCompare(b))).toEqual([
      "status",
      "workflowRunId",
    ]);

    await waitForTerminalRun(h.client, start.workflowRunId);
  });

  test("malformed input (missing required field) → isError tool result", async () => {
    // The SDK validates against the registered Zod shape pre-handler and
    // surfaces the failure as `{ isError: true, ... }` rather than a
    // rejected JSON-RPC promise.
    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR },
    });
    expect(expectToolError(raw).text).toMatch(/repo|docPath/i);
  });

  test("runtime 'cloud' without cloud spec → isError (handler-side .superRefine)", async () => {
    // The SDK's pre-handler validator is rebuilt from the inner ZodObject
    // shape and skips the cross-field `.superRefine`. The handler re-parses
    // with the full `shipInputSchema` so this invariant fires at the MCP
    // boundary — before persistence — rather than deep in the runner.
    const raw = await h.client.callTool({
      name: "ship",
      arguments: {
        workdir: TEST_WORKDIR,
        repo: "ship",
        docPath: TEST_DOC_PATH,
        runtime: "cloud",
      },
    });
    expect(expectToolError(raw).text).toMatch(/cloud config is required when runtime is 'cloud'/i);
  });

  test("workdir doesn't exist → isError 'workdir not found'", async () => {
    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: "/nope/missing", repo: "ship", docPath: TEST_DOC_PATH },
    });
    expect(expectToolError(raw).text).toMatch(/workdir/i);
  });

  test("docPath escapes workdir → isError (local only)", async () => {
    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: "../../etc/passwd" },
    });
    // Either DocPathEscapesWorkdirError or DocNotFoundError will fire,
    // depending on whether the synthetic path lands inside the in-memory
    // FS — both map to `-32602` and carry the offending docPath.
    expect(expectToolError(raw).text).toMatch(/passwd|escape|not found/i);
  });

  test("cloud without workdir or repo reaches terminal with synthetic worktree", async () => {
    await h.bundle.fs.mkdir("/external", { recursive: true });
    await h.bundle.fs.writeFile("/external/cloud-task.md", "# Cloud parity\n\nDo it.\n");
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const raw = await h.client.callTool({
      name: "ship",
      arguments: {
        docPath: "/external/cloud-task.md",
        runtime: "cloud",
        cloud: { repos: [{ url: "https://github.com/itsHabib/roxiq" }] },
      },
    });
    const start = parseToolJson(raw) as ShipStartOutput;
    expect(start.status).toBe("running");

    const terminal = await waitForTerminalRun(h.client, start.workflowRunId);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.repo).toBe("itsHabib/roxiq");
    expect(terminal.worktree.path).toBe("(cloud)");
  });

  test("tools/list returns the registered V1 tools", async () => {
    const list = await h.client.listTools();
    const names = list.tools.map((t) => t.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual([
      "cancel_workflow_run",
      "get_workflow_run",
      "list_workflow_runs",
      "ship",
    ]);
  });
});

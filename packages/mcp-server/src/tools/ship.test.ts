/**
 * `ship` tool tests — happy path + each error path. Uses the
 * in-memory MCP harness (test/mcp-harness.ts) so the request/response
 * dispatch path runs through the actual SDK, not direct method calls.
 */

import type { ShipOutput } from "@ship/mcp";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createMcpHarness,
  expectToolError,
  type McpHarness,
  parseToolJson,
  TEST_DOC_PATH,
  TEST_WORKDIR,
} from "../../test/mcp-harness.js";

let h: McpHarness;

beforeEach(async () => {
  h = await createMcpHarness();
});

afterEach(async () => {
  await h.close();
});

describe("ship tool", () => {
  test("happy path: succeeded run returns a ShipOutput with terminal status", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, summary: "shipped", branches: [] },
    });

    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: TEST_DOC_PATH },
    });
    const out = parseToolJson(raw) as ShipOutput;
    expect(out.status).toBe("succeeded");
    expect(out.workflowRunId).toMatch(/^wf_/);
    expect(out.cursorRun.status).toBe("succeeded");
    expect(out.summary).toBe("shipped");
    expect(out.artifacts.promptPath).toContain(out.workflowRunId);
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

  test("workdir doesn't exist → isError 'workdir not found'", async () => {
    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: "/nope/missing", repo: "ship", docPath: TEST_DOC_PATH },
    });
    expect(expectToolError(raw).text).toMatch(/workdir/i);
  });

  test("docPath escapes workdir → isError", async () => {
    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: "../../etc/passwd" },
    });
    // Either DocPathEscapesWorkdirError or DocNotFoundError will fire,
    // depending on whether the synthetic path lands inside the in-memory
    // FS — both map to `-32602` and carry the offending docPath.
    expect(expectToolError(raw).text).toMatch(/passwd|escape|not found/i);
  });

  test("tools/list returns the four tools (ship registered correctly)", async () => {
    const list = await h.client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel_workflow_run",
      "get_workflow_run",
      "list_workflow_runs",
      "ship",
    ]);
  });
});

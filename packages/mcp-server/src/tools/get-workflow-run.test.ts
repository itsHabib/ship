/** `get_workflow_run` tool tests — point lookup happy path + not-found. */

import type { ShipStartOutput } from "@ship/mcp";
import type { WorkflowRun } from "@ship/workflow";

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

describe("get_workflow_run tool", () => {
  test("known id returns the hydrated WorkflowRun", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: TEST_DOC_PATH },
    });
    const shipped = parseToolJson(raw) as ShipStartOutput;
    // V2: `ship` returns immediately; wait for the background
    // continuation before asserting on the terminal-state read.
    await waitForTerminalRun(h, shipped.workflowRunId);

    const got = await h.client.callTool({
      name: "get_workflow_run",
      arguments: { workflowRunId: shipped.workflowRunId },
    });
    const run = parseToolJson(got) as WorkflowRun;
    expect(run.id).toBe(shipped.workflowRunId);
    expect(run.status).toBe("succeeded");
    expect(run.repo).toBe("ship");
  });

  test("unknown id → isError 'not found'", async () => {
    const raw = await h.client.callTool({
      name: "get_workflow_run",
      arguments: { workflowRunId: "wf_01ABCDEFGHJKMNPQRSTVWXYZAB" },
    });
    expect(expectToolError(raw).text).toMatch(/not found/i);
  });

  test("malformed id (regex rejects) → isError", async () => {
    const raw = await h.client.callTool({
      name: "get_workflow_run",
      arguments: { workflowRunId: "not-a-ulid" },
    });
    expect(expectToolError(raw).text).toMatch(/workflowRunId|invalid/i);
  });
});

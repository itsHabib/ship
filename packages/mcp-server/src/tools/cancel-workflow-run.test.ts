/** `cancel_workflow_run` tool tests — idempotence + unknown-id. */

import type { CancelWorkflowRunOutput, ShipOutput } from "@ship/mcp";

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

describe("cancel_workflow_run tool", () => {
  test("cancels a terminal run idempotently (returns the existing terminal status)", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const shippedRaw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: TEST_DOC_PATH },
    });
    const shipped = parseToolJson(shippedRaw) as ShipOutput;

    const raw = await h.client.callTool({
      name: "cancel_workflow_run",
      arguments: { workflowRunId: shipped.workflowRunId },
    });
    const out = parseToolJson(raw) as CancelWorkflowRunOutput;
    expect(out.workflowRunId).toBe(shipped.workflowRunId);
    expect(out.status).toBe("succeeded");
  });

  test("unknown id → isError (WorkflowRunNotFoundError → InvalidParams)", async () => {
    const raw = await h.client.callTool({
      name: "cancel_workflow_run",
      arguments: { workflowRunId: "wf_01ABCDEFGHJKMNPQRSTVWXYZAB" },
    });
    expect(expectToolError(raw).text).toMatch(/workflow run not found|not found/i);
  });
});

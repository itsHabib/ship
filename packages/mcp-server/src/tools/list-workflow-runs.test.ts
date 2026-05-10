/** `list_workflow_runs` tool tests — happy path + filter + over-cap. */

import type { ListWorkflowRunsOutput, ShipOutput } from "@ship/mcp";

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

describe("list_workflow_runs tool", () => {
  test("empty store returns { runs: [] }", async () => {
    const raw = await h.client.callTool({ name: "list_workflow_runs", arguments: {} });
    const out = parseToolJson(raw) as ListWorkflowRunsOutput;
    expect(out.runs).toEqual([]);
  });

  test("two runs land in most-recent-first order", async () => {
    for (let i = 0; i < 2; i++) {
      h.harness.cursor.enqueue({
        events: [],
        result: { status: "succeeded", durationMs: 0, branches: [] },
      });
      await h.client.callTool({
        name: "ship",
        arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: TEST_DOC_PATH },
      });
    }
    const raw = await h.client.callTool({ name: "list_workflow_runs", arguments: {} });
    const out = parseToolJson(raw) as ListWorkflowRunsOutput;
    expect(out.runs).toHaveLength(2);
    // Most-recent first — second insertion has the larger ULID.
    expect(out.runs[0]?.id.localeCompare(out.runs[1]?.id ?? "")).toBeGreaterThan(0);
  });

  test("filter by repo='other' returns only matching runs", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const raw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: TEST_DOC_PATH },
    });
    parseToolJson(raw) as ShipOutput;

    const filteredRaw = await h.client.callTool({
      name: "list_workflow_runs",
      arguments: { repo: "other" },
    });
    const out = parseToolJson(filteredRaw) as ListWorkflowRunsOutput;
    expect(out.runs).toEqual([]);
  });

  test("limit > 200 → isError (Zod max(200) rejects at the boundary)", async () => {
    // Caught at the boundary by `listWorkflowRunsInputSchema` (max 200).
    const raw = await h.client.callTool({
      name: "list_workflow_runs",
      arguments: { limit: 99999 },
    });
    expect(expectToolError(raw).text).toMatch(/limit|max|200/i);
  });
});

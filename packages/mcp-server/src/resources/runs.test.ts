/** `ship://runs/{id}` resource tests — happy path + unknown-id + listResources. */

import type { ShipOutput } from "@ship/mcp";
import type { WorkflowRun } from "@ship/workflow";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createMcpHarness,
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

describe("ship://runs/{id} resource", () => {
  test("known id reads back as application/json with the hydrated run", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const shippedRaw = await h.client.callTool({
      name: "ship",
      arguments: { workdir: TEST_WORKDIR, repo: "ship", docPath: TEST_DOC_PATH },
    });
    const shipped = parseToolJson(shippedRaw) as ShipOutput;

    const got = await h.client.readResource({ uri: `ship://runs/${shipped.workflowRunId}` });
    expect(got.contents).toHaveLength(1);
    const block = got.contents[0];
    expect(block?.uri).toBe(`ship://runs/${shipped.workflowRunId}`);
    expect(block?.mimeType).toBe("application/json");
    if (block === undefined || !("text" in block)) {
      throw new Error(`expected text content block, got: ${JSON.stringify(block)}`);
    }
    const run = JSON.parse(block.text) as WorkflowRun;
    expect(run.id).toBe(shipped.workflowRunId);
    expect(run.status).toBe("succeeded");
  });

  test("unknown id → MCP error 'not found'", async () => {
    await expect(
      h.client.readResource({ uri: "ship://runs/wf_01ABCDEFGHJKMNPQRSTVWXYZAB" }),
    ).rejects.toThrowError(/not found/i);
  });

  test("listResources returns the single ship-run template", async () => {
    const list = await h.client.listResourceTemplates();
    const names = list.resourceTemplates.map((r) => r.name);
    expect(names).toContain("ship-run");
    const tpl = list.resourceTemplates.find((r) => r.name === "ship-run");
    expect(tpl?.uriTemplate).toBe("ship://runs/{id}");
  });
});

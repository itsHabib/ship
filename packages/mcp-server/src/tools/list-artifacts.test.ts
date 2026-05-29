/** `list_artifacts` MCP tool tests. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createMcpHarness,
  parseToolJson,
  TEST_DOC_PATH,
  TEST_WORKDIR,
  waitForTerminalRun,
} from "../../test/mcp-harness.js";

let h: Awaited<ReturnType<typeof createMcpHarness>>;

beforeEach(async () => {
  h = await createMcpHarness();
});

afterEach(async () => {
  await h.close();
});

describe("list_artifacts tool", () => {
  test("returns persisted manifest after cloud terminal", async () => {
    const ref = {
      path: "diag/log.txt",
      sizeBytes: 4,
      updatedAt: "2026-05-29T00:00:00.000Z",
    };
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [], artifacts: [ref] },
    });
    const shipped = parseToolJson(
      await h.client.callTool({
        name: "ship",
        arguments: {
          workdir: TEST_WORKDIR,
          repo: "ship",
          docPath: TEST_DOC_PATH,
          runtime: "cloud",
          cloud: { repos: [{ url: "https://github.com/acme/sandbox" }] },
        },
      }),
    ) as { workflowRunId: string };
    await waitForTerminalRun(h.client, shipped.workflowRunId);

    const raw = await h.client.callTool({
      name: "list_artifacts",
      arguments: { workflowRunId: shipped.workflowRunId },
    });
    const out = parseToolJson(raw) as { artifacts: (typeof ref)[] };
    expect(out.artifacts).toEqual([ref]);
  });
});

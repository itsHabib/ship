/** `download_artifact` MCP tool tests. */

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

describe("download_artifact tool", () => {
  test("writes artifact bytes and returns localPath", async () => {
    const ref = {
      path: "out/data.bin",
      sizeBytes: 3,
      updatedAt: "2026-05-29T00:00:00.000Z",
    };
    const payload = Buffer.from("abc");
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [], artifacts: [ref] },
      artifactBytes: { [ref.path]: payload },
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
      name: "download_artifact",
      arguments: { workflowRunId: shipped.workflowRunId, path: ref.path },
    });
    const out = parseToolJson(raw) as { localPath: string; sizeBytes: number };
    expect(out.sizeBytes).toBe(3);
    // Memory FS canonicalizes keys to POSIX separators; localPath is OS-native.
    const storedKey = out.localPath.replace(/\\/g, "/");
    expect(h.bundle.fs.snapshot().binaryFiles.get(storedKey)?.toString()).toBe("abc");
  });
});

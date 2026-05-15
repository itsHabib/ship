// Tests for `mcp.ts` — the shared `waitForTerminalRun` poll helper.

import { describe, expect, test, vi } from "vitest";

import type { ToolCaller } from "./mcp.js";

import { waitForTerminalRun } from "./mcp.js";

// Builds a `ToolCaller` fake that returns a canned `content[0].text` blob
// for each call, in order. After the array is exhausted, every subsequent
// call repeats the last entry — keeps tests terse for the "still running"
// case and lets the timeout test loop without index bookkeeping.
function fakeClient(responses: readonly { text: string; isError?: boolean }[]): {
  client: ToolCaller;
  calls: { name: string; arguments?: Record<string, unknown> }[];
} {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const callTool = vi.fn(async (req: { name: string; arguments?: Record<string, unknown> }) => {
    calls.push(req);
    const idx = Math.min(calls.length - 1, responses.length - 1);
    const r = responses[idx]!;
    return {
      content: [{ type: "text", text: r.text }],
      isError: r.isError ?? false,
    };
  });
  return { client: { callTool }, calls };
}

describe("waitForTerminalRun", () => {
  test("returns the run on the first poll when status is already terminal", async () => {
    const { client, calls } = fakeClient([
      { text: JSON.stringify({ id: "wf_abc", status: "succeeded" }) },
    ]);

    const run = await waitForTerminalRun(client, "wf_abc", { intervalMs: 1 });

    expect(run.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "get_workflow_run",
      arguments: { workflowRunId: "wf_abc" },
    });
  });

  test("polls until terminal, then resolves", async () => {
    const { client, calls } = fakeClient([
      { text: JSON.stringify({ id: "wf_abc", status: "pending" }) },
      { text: JSON.stringify({ id: "wf_abc", status: "running" }) },
      { text: JSON.stringify({ id: "wf_abc", status: "failed" }) },
    ]);

    const run = await waitForTerminalRun(client, "wf_abc", { intervalMs: 1 });

    expect(run.status).toBe("failed");
    expect(calls).toHaveLength(3);
  });

  test("times out with workflowRunId + budget in the error message", async () => {
    const { client, calls } = fakeClient([
      { text: JSON.stringify({ id: "wf_xyz", status: "running" }) },
    ]);

    await expect(
      waitForTerminalRun(client, "wf_xyz", { maxAttempts: 3, intervalMs: 1 }),
    ).rejects.toThrow(/waitForTerminalRun\(wf_xyz\): timed out after 3 attempts × 1ms/);
    expect(calls).toHaveLength(3);
  });

  test("propagates an isError tool response with workflowRunId prefix", async () => {
    const { client } = fakeClient([
      { text: "workflow run not found: wf_missing", isError: true },
    ]);

    await expect(
      waitForTerminalRun(client, "wf_missing", { intervalMs: 1 }),
    ).rejects.toThrow(/waitForTerminalRun\(wf_missing\): poll failed —.*not found/);
  });

  test("propagates a malformed-shape response with workflowRunId prefix", async () => {
    // `content[0].type` isn't "text" → parseWorkflowRunResult throws,
    // and the outer catch rewraps with the workflowRunId.
    const client: ToolCaller = {
      callTool: vi.fn(async () => ({ content: [{ type: "image", data: "..." }], isError: false })),
    };

    await expect(
      waitForTerminalRun(client, "wf_bad", { intervalMs: 1 }),
    ).rejects.toThrow(/waitForTerminalRun\(wf_bad\): poll failed — unexpected tool response shape/);
  });

  test("propagates a non-Error throwable with String() coercion", async () => {
    const client: ToolCaller = {
      callTool: vi.fn(async () => {
        throw "raw string failure";
      }),
    };

    await expect(
      waitForTerminalRun(client, "wf_str", { intervalMs: 1 }),
    ).rejects.toThrow(/waitForTerminalRun\(wf_str\): poll failed — raw string failure/);
  });

  test("honors custom maxAttempts and intervalMs", async () => {
    const { client, calls } = fakeClient([
      { text: JSON.stringify({ id: "wf_t", status: "running" }) },
    ]);

    await expect(
      waitForTerminalRun(client, "wf_t", { maxAttempts: 5, intervalMs: 2 }),
    ).rejects.toThrow(/timed out after 5 attempts × 2ms/);
    expect(calls).toHaveLength(5);
  });

  test("defaults match the unit-harness budget (200 × 10ms) when opts omitted", async () => {
    // The defaults are documented as 200 × 10ms = 2s; exercising the full
    // budget here would slow the suite by ~2s. Use a single-poll terminal
    // response to assert the call goes through with no opts, deferring
    // budget-value coverage to the explicit-opts cases above.
    const { client, calls } = fakeClient([
      { text: JSON.stringify({ id: "wf_d", status: "succeeded" }) },
    ]);

    const run = await waitForTerminalRun(client, "wf_d");

    expect(run.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
  });
});

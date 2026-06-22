/** Tests for the shared SDK run handle state machine. */

import { describe, expect, test, vi } from "vitest";

import type { AgentRunResult } from "./runner.js";

import { buildSdkRunHandle, createSdkRunHandleState } from "./handle-state.js";

function baseResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    status: "succeeded",
    summary: "done",
    durationMs: 100,
    branches: [],
    ...overrides,
  };
}

describe("createSdkRunHandleState", () => {
  test("finalizeOk resolves result once", async () => {
    const cancelRun = vi.fn(() => Promise.resolve());
    const state = createSdkRunHandleState({ cancelRun });
    state.callbacks.finalizeOk(baseResult());
    await expect(state.result).resolves.toEqual(baseResult());
    state.callbacks.finalizeOk(baseResult({ summary: "ignored" }));
    await expect(state.result).resolves.toEqual(baseResult());
  });

  test("finalizeError rejects result once", async () => {
    const cancelRun = vi.fn(() => Promise.resolve());
    const state = createSdkRunHandleState({ cancelRun });
    const err = new Error("stream failed");
    state.callbacks.finalizeError(err);
    await expect(state.result).rejects.toThrow("stream failed");
    state.callbacks.finalizeError(new Error("ignored"));
    await expect(state.result).rejects.toThrow("stream failed");
  });

  test("cancelInternal invokes cancelRun once and retries on transient failure", async () => {
    const cancelRun = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(undefined);
    const state = createSdkRunHandleState({ cancelRun });
    await state.cancelInternal();
    expect(cancelRun).toHaveBeenCalledTimes(1);
    await state.cancelInternal();
    expect(cancelRun).toHaveBeenCalledTimes(2);
  });

  test("cancelInternal is idempotent after success", async () => {
    const cancelRun = vi.fn(() => Promise.resolve());
    const state = createSdkRunHandleState({ cancelRun });
    await state.cancelInternal();
    await state.cancelInternal();
    expect(cancelRun).toHaveBeenCalledTimes(1);
  });

  test("pre-aborted signal triggers cancel on construction", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelRun = vi.fn(() => Promise.resolve());
    createSdkRunHandleState({ cancelRun, signal: controller.signal });
    await vi.waitFor(() => {
      expect(cancelRun).toHaveBeenCalledTimes(1);
    });
  });

  test("signal abort triggers cancel and detaches listener on finalize", async () => {
    const controller = new AbortController();
    const cancelRun = vi.fn(() => Promise.resolve());
    const state = createSdkRunHandleState({ cancelRun, signal: controller.signal });
    controller.abort();
    await vi.waitFor(() => {
      expect(cancelRun).toHaveBeenCalledTimes(1);
    });
    state.callbacks.finalizeOk(baseResult());
    await expect(state.result).resolves.toEqual(baseResult());
    state.callbacks.detachSignalListener();
  });
});

describe("buildSdkRunHandle", () => {
  test("wires agentId, runId, cancel, and result from state", async () => {
    const cancelRun = vi.fn(() => Promise.resolve());
    const state = createSdkRunHandleState({ cancelRun });
    const handle = buildSdkRunHandle({ agentId: "agent-1", runId: "run-1", state });
    expect(handle.agentId).toBe("agent-1");
    expect(handle.runId).toBe("run-1");
    await handle.cancel();
    expect(cancelRun).toHaveBeenCalledTimes(1);
    state.callbacks.finalizeOk(baseResult({ summary: "wired" }));
    await expect(handle.result).resolves.toMatchObject({ summary: "wired" });
    await handle.cancel();
    expect(cancelRun).toHaveBeenCalledTimes(1);
  });
});

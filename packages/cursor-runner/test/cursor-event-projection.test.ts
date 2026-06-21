/** Normalization tests for `cursorEventProjection`. */

import type { SDKMessage } from "@cursor/sdk";

import { describe, expect, test } from "vitest";

import { cursorEventProjection } from "../src/cursor-event-projection.js";

describe("cursorEventProjection", () => {
  test("normalizes uppercase ERROR status events", () => {
    const ev = { type: "status", status: "ERROR", message: "boom" } as unknown as SDKMessage;
    expect(cursorEventProjection.terminalStatus(ev)).toBe("ERROR");
    expect(cursorEventProjection.statusMessage(ev)).toBe("boom");
  });

  test("normalizes failed and error tool_call statuses", () => {
    const failed = { type: "tool_call", status: "failed", name: "grep" } as unknown as SDKMessage;
    const error = { type: "tool_call", status: "error", result: "x" } as unknown as SDKMessage;
    expect(cursorEventProjection.toolCallStatus(failed)).toBe("failed");
    expect(cursorEventProjection.toolCallStatus(error)).toBe("error");
  });

  test("extracts call_id for reconciliation", () => {
    const ev = {
      type: "tool_call",
      status: "running",
      call_id: "abc",
      name: "shell",
      args: { command: "make check" },
    } as unknown as SDKMessage;
    expect(cursorEventProjection.toolCallId(ev)).toBe("abc");
    expect(cursorEventProjection.commandArg(ev)).toBe("make check");
  });
});

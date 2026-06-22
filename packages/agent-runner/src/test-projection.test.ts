/** Tests for the in-tree test EventProjection double. */

import { describe, expect, test } from "vitest";

import { testEventProjection } from "./test-projection.js";

describe("testEventProjection", () => {
  test("reads tool_call fields from plain objects", () => {
    const ev = {
      type: "tool_call",
      status: "running",
      name: "shell",
      call_id: "c1",
      args: { command: "make check" },
      result: "ok",
      ts: "2026-06-01T12:00:00.000Z",
    };
    expect(testEventProjection.eventKind(ev)).toBe("tool_call");
    expect(testEventProjection.toolCallStatus(ev)).toBe("running");
    expect(testEventProjection.toolCallName(ev)).toBe("shell");
    expect(testEventProjection.toolCallId(ev)).toBe("c1");
    expect(testEventProjection.commandArg(ev)).toBe("make check");
    expect(testEventProjection.resultText(ev)).toBe("ok");
    expect(testEventProjection.timestamp(ev)).toBe(Date.parse("2026-06-01T12:00:00.000Z"));
  });

  test("returns undefined for non-tool events and invalid shapes", () => {
    expect(testEventProjection.toolCallStatus({ type: "status" })).toBeUndefined();
    expect(
      testEventProjection.toolCallStatus({ type: "tool_call", status: "weird" }),
    ).toBeUndefined();
    expect(testEventProjection.commandArg({ type: "tool_call", args: null })).toBeUndefined();
    expect(testEventProjection.timestamp({ ts: "not-a-date" })).toBeUndefined();
  });

  test("reads status messages and terminal status", () => {
    expect(testEventProjection.statusMessage({ type: "status", message: "done" })).toBe("done");
    expect(testEventProjection.terminalStatus({ type: "status", status: "ERROR" })).toBe("ERROR");
  });
});

/** Tests for projection-driven event stream helpers. */

import { describe, expect, test } from "vitest";

import {
  lastEventTimestamp,
  lastFailedToolCallDetail,
  lastRunningToolCall,
  lastTerminalStatus,
  runningToolDetail,
} from "./projection-helpers.js";
import { testEventProjection } from "./test-projection.js";

const projection = testEventProjection;

describe("lastRunningToolCall", () => {
  test("returns running tool reconciled by call_id final status", () => {
    const events = [
      { type: "tool_call", status: "running", name: "grep", call_id: "c1" },
      { type: "tool_call", status: "completed", name: "grep", call_id: "c1" },
      { type: "tool_call", status: "running", name: "shell", call_id: "c2" },
    ];
    expect(lastRunningToolCall(projection, events)?.name).toBe("shell");
  });

  test("returns undefined when no running tool remains", () => {
    const events = [{ type: "tool_call", status: "completed", name: "grep", call_id: "c1" }];
    expect(lastRunningToolCall(projection, events)).toBeUndefined();
  });
});

describe("lastFailedToolCallDetail", () => {
  test("uses result text when present", () => {
    const events = [{ type: "tool_call", status: "failed", name: "grep", result: "not found" }];
    expect(lastFailedToolCallDetail(projection, events)).toBe("not found");
  });

  test("falls back to tool name when result is empty", () => {
    const events = [{ type: "tool_call", status: "error", name: "grep" }];
    expect(lastFailedToolCallDetail(projection, events)).toBe("grep errored");
  });
});

describe("lastEventTimestamp", () => {
  test("returns the latest parseable timestamp", () => {
    const events = [
      { type: "status", ts: "2026-06-01T12:00:00.000Z" },
      { type: "status", ts: "2026-06-01T12:05:00.000Z" },
    ];
    expect(lastEventTimestamp(projection, events)).toBe(Date.parse("2026-06-01T12:05:00.000Z"));
  });
});

describe("lastTerminalStatus", () => {
  test("returns the latest status event", () => {
    const events = [
      { type: "status", status: "RUNNING" },
      { type: "status", status: "ERROR" },
    ];
    expect(lastTerminalStatus(projection, events)).toBe("ERROR");
  });
});

describe("runningToolDetail", () => {
  test("formats running tool summary with age", () => {
    const detail = runningToolDetail(
      { command: "make check", name: "shell", timestamp: undefined },
      90_000,
      (ms) => `${String(Math.round(ms / 1000))}s`,
    );
    expect(detail).toContain("shell 'make check'");
    expect(detail).toContain("never completed");
  });
});

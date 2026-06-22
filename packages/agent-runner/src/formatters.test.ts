/** Tests for shared duration and tool-call formatters. */

import { describe, expect, test } from "vitest";

import {
  formatRunningToolAge,
  formatWallDuration,
  stringifyToolCallResult,
  summarizeToolCall,
} from "./formatters.js";

describe("formatWallDuration", () => {
  test("formats sub-hour durations in minutes", () => {
    expect(formatWallDuration(90_000)).toBe("2m");
    expect(formatWallDuration(0)).toBe("0m");
  });

  test("formats hour+ durations with optional remainder minutes", () => {
    expect(formatWallDuration(3_600_000)).toBe("1h");
    expect(formatWallDuration(5_400_000)).toBe("1h30m");
  });
});

describe("formatRunningToolAge", () => {
  test("formats seconds-only ages", () => {
    expect(formatRunningToolAge(45_000)).toBe("45s");
  });

  test("formats minute+ ages", () => {
    expect(formatRunningToolAge(120_000)).toBe("2m");
    expect(formatRunningToolAge(150_000)).toBe("2m30s");
  });
});

describe("summarizeToolCall", () => {
  test("uses tool name when command is absent", () => {
    expect(summarizeToolCall("grep", undefined)).toBe("grep");
    expect(summarizeToolCall(undefined, undefined)).toBe("tool");
  });

  test("truncates long commands", () => {
    const long = "x".repeat(100);
    const summary = summarizeToolCall("shell", long);
    expect(summary.length).toBeLessThanOrEqual(80 + "shell ".length + 2);
    expect(summary).toContain("...");
  });
});

describe("stringifyToolCallResult", () => {
  test("returns strings and primitives directly", () => {
    expect(stringifyToolCallResult("ok")).toBe("ok");
    expect(stringifyToolCallResult(42)).toBe("42");
    expect(stringifyToolCallResult(true)).toBe("true");
  });

  test("returns empty string for nullish values", () => {
    expect(stringifyToolCallResult(null)).toBe("");
    expect(stringifyToolCallResult(undefined)).toBe("");
  });

  test("JSON-stringifies objects and falls back on failure", () => {
    expect(stringifyToolCallResult({ err: "bad" })).toBe('{"err":"bad"}');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(stringifyToolCallResult(circular)).toBe("tool_call error");
  });
});

/** Table-driven tests for Codex-bound `classifyFailure` and `buildFailureDetail`. */

import type { ThreadEvent } from "@openai/codex-sdk";

import { describe, expect, test } from "vitest";

import { buildFailureDetail, classifyFailure } from "./classify-failure.js";

describe("classifyFailure (Codex)", () => {
  test("failed sandbox command → sandbox-denial", () => {
    const events = [
      {
        item: {
          aggregated_output: "not permitted in the sandbox",
          command: "curl evil",
          id: "cmd-1",
          status: "failed",
          type: "command_execution",
        },
        type: "item.completed",
      },
    ] as ThreadEvent[];
    expect(classifyFailure({ events, sdkTerminalStatus: "turn.failed" })).toBe("sandbox-denial");
  });

  test("failed file_change → patch-apply-fail", () => {
    const events = [
      {
        item: {
          changes: [{ kind: "update", path: "a.ts" }],
          id: "fc-1",
          status: "failed",
          type: "file_change",
        },
        type: "item.completed",
      },
    ] as ThreadEvent[];
    expect(classifyFailure({ events, sdkTerminalStatus: "turn.failed" })).toBe("patch-apply-fail");
  });

  test("mid-stream ECONNREFUSED → gateway-unreachable", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("connect ECONNREFUSED"),
        thrownError: true,
      }),
    ).toBe("gateway-unreachable");
  });

  test("mid-stream generic throw → sdk-throw", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("unexpected"),
        thrownError: true,
      }),
    ).toBe("sdk-throw");
  });

  test("turn.failed with 5xx gateway message → gateway-unreachable", () => {
    const events = [
      { error: { message: "gateway returned 502" }, type: "turn.failed" },
    ] as ThreadEvent[];
    expect(classifyFailure({ events, sdkTerminalStatus: "turn.failed" })).toBe(
      "gateway-unreachable",
    );
  });

  test("turn.failed with 4xx (401) gateway message → NOT gateway-unreachable", () => {
    const events = [
      { error: { message: "gateway returned 401 Unauthorized" }, type: "turn.failed" },
    ] as ThreadEvent[];
    // 401 is an auth failure, not transport — must not be mislabeled gateway-unreachable.
    expect(classifyFailure({ events, sdkTerminalStatus: "turn.failed" })).toBe("unknown");
  });

  test("failed command whose OUTPUT mentions 'fetch failed' → logic, not gateway", () => {
    const events = [
      {
        item: {
          aggregated_output: "curl: fetch failed",
          command: "curl https://api",
          id: "cmd-1",
          status: "failed",
          type: "command_execution",
        },
        type: "item.completed",
      },
      { error: { message: "command failed" }, type: "turn.failed" },
    ] as ThreadEvent[];
    expect(classifyFailure({ events, sdkTerminalStatus: "turn.failed" })).toBe("logic");
  });

  test("non-terminal status with no signals delegates to base → unknown", () => {
    expect(classifyFailure({ events: [], sdkTerminalStatus: "stream-end" })).toBe("unknown");
  });

  test("recency: earlier sandbox denial then later failed file_change → patch-apply-fail", () => {
    const events = [
      {
        item: {
          aggregated_output: "not permitted in the sandbox",
          command: "curl evil",
          id: "cmd-1",
          status: "failed",
          type: "command_execution",
        },
        type: "item.completed",
      },
      {
        item: {
          changes: [{ kind: "update", path: "a.ts" }],
          id: "fc-1",
          status: "failed",
          type: "file_change",
        },
        type: "item.completed",
      },
    ] as ThreadEvent[];
    expect(classifyFailure({ events, sdkTerminalStatus: "turn.failed" })).toBe("patch-apply-fail");
  });

  test("recency: earlier failed file_change then later sandbox denial → sandbox-denial", () => {
    const events = [
      {
        item: {
          changes: [{ kind: "update", path: "a.ts" }],
          id: "fc-1",
          status: "failed",
          type: "file_change",
        },
        type: "item.completed",
      },
      {
        item: {
          aggregated_output: "operation not permitted in the sandbox",
          command: "rm -rf /",
          id: "cmd-1",
          status: "failed",
          type: "command_execution",
        },
        type: "item.completed",
      },
    ] as ThreadEvent[];
    expect(classifyFailure({ events, sdkTerminalStatus: "turn.failed" })).toBe("sandbox-denial");
  });

  test("turn.failed without codex-specific signals delegates to base → unknown", () => {
    expect(classifyFailure({ events: [], sdkTerminalStatus: "turn.failed" })).toBe("unknown");
  });

  test("top-level error event text in tail → gateway-unreachable", () => {
    const events = [{ message: "fetch failed", type: "error" } as ThreadEvent];
    expect(
      classifyFailure({
        events,
        sdkTerminalStatus: "error",
      }),
    ).toBe("gateway-unreachable");
  });

  test("errorText handles non-string thrown errors", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: { code: 1 },
        thrownError: true,
      }),
    ).toBe("sdk-throw");
  });

  test("failed mcp tool_call delegates to logic via base classifier", () => {
    const events = [
      {
        item: {
          arguments: {},
          error: { message: "lookup failed" },
          id: "mcp-1",
          server: "docs",
          status: "failed",
          tool: "search",
          type: "mcp_tool_call",
        },
        type: "item.completed",
      },
    ] as ThreadEvent[];
    expect(classifyFailure({ events, sdkTerminalStatus: "turn.failed" })).toBe("logic");
  });
});

describe("buildFailureDetail (Codex)", () => {
  test("sandbox-denial uses raw error message", () => {
    expect(
      buildFailureDetail({
        category: "sandbox-denial",
        events: [],
        rawErrorMessage: "sandbox blocked",
      }),
    ).toBe("sandbox blocked");
  });
});

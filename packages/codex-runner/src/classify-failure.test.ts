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

  test("turn.failed with gateway text → gateway-unreachable", () => {
    expect(
      classifyFailure({
        events: [],
        rawErrorMessage: "gateway returned 502",
        sdkTerminalStatus: "turn.failed",
      }),
    ).toBe("gateway-unreachable");
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

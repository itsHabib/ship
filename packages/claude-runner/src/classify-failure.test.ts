/** Table-driven tests for Claude-bound `classifyFailure` and `buildFailureDetail`. */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { describe, expect, test } from "vitest";

import { buildFailureDetail, classifyFailure } from "./classify-failure.js";

describe("classifyFailure (Claude)", () => {
  test("error_max_budget_usd → budget-exceeded", () => {
    expect(classifyFailure({ events: [], sdkTerminalStatus: "error_max_budget_usd" })).toBe(
      "budget-exceeded",
    );
  });

  test("error_max_turns → budget-exceeded", () => {
    expect(classifyFailure({ events: [], sdkTerminalStatus: "error_max_turns" })).toBe(
      "budget-exceeded",
    );
  });

  test("error_max_structured_output_retries → logic", () => {
    expect(
      classifyFailure({ events: [], sdkTerminalStatus: "error_max_structured_output_retries" }),
    ).toBe("logic");
  });

  test("error_during_execution delegates to projection for tool errors", () => {
    const events = [
      {
        message: {
          content: [
            { content: "make failed", is_error: true, tool_use_id: "tu-1", type: "tool_result" },
          ],
        },
        type: "user",
      },
    ] as unknown as SDKMessage[];
    expect(classifyFailure({ events, sdkTerminalStatus: "error_during_execution" })).toBe("logic");
  });

  test("error_during_execution with no signals → unknown", () => {
    expect(classifyFailure({ events: [], sdkTerminalStatus: "error_during_execution" })).toBe(
      "unknown",
    );
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

  test("gateway 502 text → gateway-unreachable", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: "gateway returned 502",
        thrownError: true,
      }),
    ).toBe("gateway-unreachable");
  });

  test("401 Unauthorized → gateway-auth", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("401 Unauthorized"),
        thrownError: true,
      }),
    ).toBe("gateway-auth");
  });

  test("403 Forbidden → gateway-auth", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("403 Forbidden"),
        thrownError: true,
      }),
    ).toBe("gateway-auth");
  });

  test("401 without gateway keyword → gateway-auth, not sdk-throw", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("HTTP 401: invalid API key"),
        thrownError: true,
      }),
    ).toBe("gateway-auth");
  });

  test("gateway returned 401 → gateway-auth", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("gateway returned 401"),
        thrownError: true,
      }),
    ).toBe("gateway-auth");
  });

  test("gateway returned 403 → gateway-auth", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("gateway returned 403"),
        thrownError: true,
      }),
    ).toBe("gateway-auth");
  });

  test("gateway 4xx → not gateway-unreachable (wrong-endpoint, not transport)", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("gateway returned 404 Not Found"),
        thrownError: true,
      }),
    ).not.toBe("gateway-unreachable");
  });

  test("gateway returned 502 → gateway-unreachable, not gateway-auth", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("gateway returned 502 Bad Gateway"),
        thrownError: true,
      }),
    ).toBe("gateway-unreachable");
  });

  test("5xx gateway error → gateway-unreachable, not gateway-auth", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("gateway returned 503 Service Unavailable"),
        thrownError: true,
      }),
    ).toBe("gateway-unreachable");
  });

  test("output merely mentioning 401 → NOT gateway-auth", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: new Error("lint found 401 style violations"),
        thrownError: true,
      }),
    ).toBe("sdk-throw");
  });

  test("non-error subtype delegates to base classifier", () => {
    const events = [
      {
        message: {
          content: [
            { content: "logic failure", is_error: true, tool_use_id: "tu-1", type: "tool_result" },
          ],
        },
        type: "user",
      },
    ] as unknown as SDKMessage[];
    expect(
      classifyFailure({
        durationMs: 30 * 60 * 1000,
        events,
        maxRunDurationMs: 30 * 60 * 1000,
        sdkTerminalStatus: "error_during_execution",
      }),
    ).toBe("logic");
  });

  test("unknown sdk subtype with no signals stays unknown via base classifier", () => {
    expect(classifyFailure({ events: [], sdkTerminalStatus: "weird_status" })).toBe("unknown");
  });

  test("errorText handles plain string thrown errors", () => {
    expect(
      classifyFailure({
        events: [],
        thrownErr: "ECONNRESET",
        thrownError: true,
      }),
    ).toBe("gateway-unreachable");
  });
});

describe("buildFailureDetail (Claude)", () => {
  test("budget-exceeded uses sdk subtype", () => {
    expect(
      buildFailureDetail({
        category: "budget-exceeded",
        events: [],
        sdkTerminalStatus: "error_max_turns",
      }),
    ).toBe("SDK status error_max_turns");
  });
});

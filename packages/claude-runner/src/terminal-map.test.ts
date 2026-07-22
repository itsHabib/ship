/** Tests for `terminal-map.ts`. */

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { describe, expect, test } from "vitest";

import type { AgentRunInput } from "./runner.js";

import {
  buildTerminalErrorMessage,
  mapMidStreamFailure,
  mapResultMessage,
} from "./terminal-map.js";

const baseInput = (): AgentRunInput => ({
  cwd: "/tmp",
  model: { id: "claude-sonnet-4-20250514" },
  onEvent: () => undefined,
  prompt: "do work",
});

describe("mapResultMessage", () => {
  test("success maps to succeeded with summary, usage, cost, and empty branches", () => {
    const msg = {
      duration_ms: 5000,
      result: "done",
      subtype: "success",
      type: "result",
      total_cost_usd: 0.42,
      usage: {
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        input_tokens: 100,
        output_tokens: 50,
      },
    } as SDKResultMessage;
    expect(mapResultMessage(msg, baseInput(), [])).toMatchObject({
      branches: [],
      costUsd: 0.42,
      durationMs: 5000,
      status: "succeeded",
      summary: "done",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 165,
      },
    });
  });

  test("fractional SDK duration_ms is rounded to a whole ms on success and failure", () => {
    // durationMs flows into the result.json artifact, the cursor_runs int
    // column, and the MCP `.int()` diagnostics schema; the source must emit an
    // integer so a failed terminal's artifact (read back by loadRunDiagnostics)
    // does not carry a fraction the diagnostics schema rejects.
    const success = {
      duration_ms: 3_723_030.9877,
      result: "done",
      subtype: "success",
      type: "result",
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 1,
        output_tokens: 1,
      },
    } as SDKResultMessage;
    expect(mapResultMessage(success, baseInput(), []).durationMs).toBe(3_723_031);

    const failure = {
      duration_ms: 100.4,
      errors: ["turn cap hit"],
      subtype: "error_max_turns",
      type: "result",
    } as SDKResultMessage;
    expect(mapResultMessage(failure, baseInput(), []).durationMs).toBe(100);
  });

  test("error maps to failed with joined errors and budget category", () => {
    const msg = {
      duration_ms: 100,
      errors: ["turn cap hit"],
      subtype: "error_max_turns",
      type: "result",
    } as SDKResultMessage;
    const result = mapResultMessage(msg, baseInput(), []);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("turn cap hit");
    expect(result.failureCategory).toBe("budget-exceeded");
    expect(result.sdkTerminalStatus).toBe("error_max_turns");
  });

  test("empty errors fall back to event tail synthesis", () => {
    const msg = {
      duration_api_ms: 0,
      duration_ms: 100,
      errors: [],
      is_error: true,
      modelUsage: {},
      num_turns: 1,
      permission_denials: [],
      stop_reason: null,
      subtype: "error_during_execution",
      total_cost_usd: 0,
      type: "result",
      usage: {},
      uuid: "00000000-0000-4000-8000-000000000002",
      session_id: "sess-1",
    } as unknown as Extract<SDKResultMessage, { subtype: "error_during_execution" }>;
    const events = [
      {
        message: {
          content: [
            { content: "tool broke", is_error: true, tool_use_id: "tu-1", type: "tool_result" },
          ],
        },
        type: "user",
      },
    ] as unknown as SDKMessage[];
    expect(buildTerminalErrorMessage(msg, events)).toBe("tool broke");
  });

  test("buildTerminalErrorMessage joins errors and terminal_reason", () => {
    const msg = {
      duration_api_ms: 0,
      duration_ms: 10,
      errors: ["cap"],
      is_error: true,
      modelUsage: {},
      num_turns: 1,
      permission_denials: [],
      stop_reason: null,
      subtype: "error_max_budget_usd",
      terminal_reason: "max_budget",
      total_cost_usd: 0,
      type: "result",
      usage: {},
      uuid: "00000000-0000-4000-8000-000000000003",
      session_id: "sess-1",
    } as unknown as Extract<SDKResultMessage, { subtype: "error_max_budget_usd" }>;
    expect(buildTerminalErrorMessage(msg, [])).toBe("cap; max_budget");
  });

  test("buildTerminalErrorMessage uses generic fallback when no detail exists", () => {
    const msg = {
      duration_api_ms: 0,
      duration_ms: 10,
      errors: [],
      is_error: true,
      modelUsage: {},
      num_turns: 1,
      permission_denials: [],
      stop_reason: null,
      subtype: "error_max_structured_output_retries",
      total_cost_usd: 0,
      type: "result",
      usage: {},
      uuid: "00000000-0000-4000-8000-000000000004",
      session_id: "sess-1",
    } as unknown as Extract<SDKResultMessage, { subtype: "error_max_structured_output_retries" }>;
    expect(buildTerminalErrorMessage(msg, [])).toContain("error_max_structured_output_retries");
  });

  test("failed result includes maxRunDurationMs in classification when set", () => {
    const msg = {
      duration_ms: 100,
      errors: ["turn cap hit"],
      subtype: "error_max_turns",
      type: "result",
    } as SDKResultMessage;
    const input = { ...baseInput(), maxRunDurationMs: 30 * 60 * 1000 };
    const result = mapResultMessage(msg, input, []);
    expect(result.failureDetail).toContain("error_max_turns");
  });
});

describe("mapMidStreamFailure", () => {
  test("gateway transport throw resolves failed with gateway-unreachable", () => {
    const result = mapMidStreamFailure(new Error("fetch failed"), baseInput(), []);
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("gateway-unreachable");
    expect(result.errorMessage).toBe("fetch failed");
  });

  test("401 auth rejection resolves failed with gateway-auth", () => {
    const result = mapMidStreamFailure(new Error("401 Unauthorized"), baseInput(), []);
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("gateway-auth");
    expect(result.errorMessage).toBe("401 Unauthorized");
  });

  test("non-gateway throw resolves sdk-throw category", () => {
    const result = mapMidStreamFailure(new Error("unexpected"), baseInput(), []);
    expect(result.failureCategory).toBe("sdk-throw");
  });

  test("mid-stream failure honors maxRunDurationMs in detail input", () => {
    const input = { ...baseInput(), maxRunDurationMs: 60_000 };
    const result = mapMidStreamFailure(new Error("unexpected"), input, []);
    expect(result.failureCategory).toBe("sdk-throw");
    expect(result.classificationEvents).toEqual([]);
  });
});

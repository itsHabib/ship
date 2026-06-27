/** Tests for `terminal-map.ts`. */

import type { ThreadEvent } from "@openai/codex-sdk";

import { describe, expect, test } from "vitest";

import type { AgentRunInput } from "./runner.js";

import {
  mapCancelled,
  mapMidStreamFailure,
  mapStreamEndWithoutTerminal,
  mapTerminalEvent,
} from "./terminal-map.js";

const baseInput = (): AgentRunInput => ({
  cwd: "/tmp",
  model: { id: "gpt-5.3-codex" },
  onEvent: () => undefined,
  prompt: "do work",
});

describe("mapTerminalEvent", () => {
  test("turn.completed maps to succeeded with last agent_message summary", () => {
    const events = [
      {
        item: { id: "msg-1", text: "implementation done", type: "agent_message" },
        type: "item.completed",
      },
      {
        type: "turn.completed",
        usage: {
          cached_input_tokens: 0,
          input_tokens: 1,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ] as ThreadEvent[];
    const terminal = events[1]!;
    expect(mapTerminalEvent(terminal, baseInput(), events, 1500)).toMatchObject({
      branches: [],
      durationMs: 1500,
      status: "succeeded",
      summary: "implementation done",
    });
  });

  test("turn.failed maps to failed with category", () => {
    const terminal = {
      error: { message: "logic error" },
      type: "turn.failed",
    } as ThreadEvent;
    const result = mapTerminalEvent(terminal, baseInput(), [], 100);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("logic error");
    expect(result.sdkTerminalStatus).toBe("turn.failed");
  });

  test("top-level error maps to failed", () => {
    const terminal = { message: "stream fatal", type: "error" } as ThreadEvent;
    const result = mapTerminalEvent(terminal, baseInput(), [], 50);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("stream fatal");
    expect(result.sdkTerminalStatus).toBe("error");
  });

  test("turn.completed without agent_message yields empty summary", () => {
    const terminal = {
      type: "turn.completed",
      usage: {
        cached_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    } as ThreadEvent;
    expect(mapTerminalEvent(terminal, baseInput(), [], 10)).toMatchObject({
      status: "succeeded",
      summary: "",
    });
  });

  test("turn.failed without message synthesizes from event tail", () => {
    const events = [
      {
        item: {
          aggregated_output: "tail error detail",
          command: "make check",
          id: "cmd-1",
          status: "failed",
          type: "command_execution",
        },
        type: "item.completed",
      },
    ] as ThreadEvent[];
    const terminal = { error: { message: "" }, type: "turn.failed" } as ThreadEvent;
    const result = mapTerminalEvent(terminal, baseInput(), events, 100);
    expect(result.errorMessage).toBe("tail error detail");
  });

  test("turn.failed with no message anywhere uses generic fallback", () => {
    const terminal = { error: { message: "" }, type: "turn.failed" } as ThreadEvent;
    const result = mapTerminalEvent(terminal, baseInput(), [], 100);
    expect(result.errorMessage).toContain("turn.failed");
  });

  test("failed result includes maxRunDurationMs in classification when set", () => {
    const terminal = { error: { message: "boom" }, type: "turn.failed" } as ThreadEvent;
    const input = { ...baseInput(), maxRunDurationMs: 30 * 60 * 1000 };
    const result = mapTerminalEvent(terminal, input, [], 100);
    expect(result.failureDetail).toBeDefined();
  });
});

describe("mapMidStreamFailure", () => {
  test("gateway transport throw resolves failed with gateway-unreachable", () => {
    const result = mapMidStreamFailure(new Error("fetch failed"), baseInput(), [], 0);
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("gateway-unreachable");
  });

  test("non-gateway throw resolves sdk-throw category", () => {
    const result = mapMidStreamFailure(new Error("unexpected"), baseInput(), [], 0);
    expect(result.failureCategory).toBe("sdk-throw");
  });

  test("mid-stream failure honors maxRunDurationMs in detail input", () => {
    const input = { ...baseInput(), maxRunDurationMs: 60_000 };
    const result = mapMidStreamFailure(new Error("unexpected"), input, [], 0);
    expect(result.failureCategory).toBe("sdk-throw");
    expect(result.classificationEvents).toEqual([]);
  });

  test("non-Error throw uses String() for error message", () => {
    const result = mapMidStreamFailure("plain failure", baseInput(), [], 0);
    expect(result.errorMessage).toBe("plain failure");
  });
});

describe("mapStreamEndWithoutTerminal", () => {
  test("returns failed sdk-throw when stream ends without terminal turn", () => {
    const result = mapStreamEndWithoutTerminal(baseInput(), [], 200);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("without a terminal turn event");
    // A stream that ends with no terminal turn event is a transport/SDK failure.
    expect(result.failureCategory).toBe("sdk-throw");
  });
});

describe("mapCancelled", () => {
  test("returns a cancelled result with empty branches", () => {
    expect(mapCancelled(1234)).toEqual({ branches: [], durationMs: 1234, status: "cancelled" });
  });
});

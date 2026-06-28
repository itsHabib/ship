/**
 * Tests for `cloud-terminal-map.ts` — every terminal signal + failure category.
 * Pure logic; no SDK mock needed.
 */

import { describe, expect, test } from "vitest";

import type { CloudStreamEvent } from "./cloud-session.js";

import {
  detectTerminal,
  mapCloudStreamEnded,
  mapCloudStreamThrow,
  newCloudTerminalState,
} from "./cloud-terminal-map.js";

// Helpers to build typed fake events without importing @anthropic-ai/sdk.
function makeIdleEvent(stopReasonType: string): CloudStreamEvent {
  return {
    type: "session.status_idle",
    stop_reason: { type: stopReasonType },
  } as unknown as CloudStreamEvent;
}

function makeTerminatedEvent(): CloudStreamEvent {
  return { type: "session.status_terminated" } as unknown as CloudStreamEvent;
}

function makeDeletedEvent(): CloudStreamEvent {
  return { type: "session.deleted" } as unknown as CloudStreamEvent;
}

function makeErrorEvent(errorType: string, message = "some error"): CloudStreamEvent {
  return {
    type: "session.error",
    error: { type: errorType, message },
  } as unknown as CloudStreamEvent;
}

function makeAgentMessageEvent(texts: string[]): CloudStreamEvent {
  return {
    type: "agent.message",
    content: texts.map((t) => ({ type: "text", text: t })),
  } as unknown as CloudStreamEvent;
}

const WALL = 1234;
const CAPS: readonly unknown[] = [];

describe("detectTerminal — agent.message accumulation", () => {
  test("single agent.message accumulates text into state", () => {
    const state = newCloudTerminalState();
    const result = detectTerminal(state, makeAgentMessageEvent(["hello world"]), WALL, CAPS);
    expect(result).toBeUndefined();
    expect(state.agentMessageParts).toEqual(["hello world"]);
  });

  test("empty content does not append to agentMessageParts", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeAgentMessageEvent([]), WALL, CAPS);
    expect(state.agentMessageParts).toHaveLength(0);
  });

  test("multiple messages accumulate in order", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeAgentMessageEvent(["first"]), WALL, CAPS);
    detectTerminal(state, makeAgentMessageEvent(["second"]), WALL, CAPS);
    expect(state.agentMessageParts).toEqual(["first", "second"]);
  });

  test("non-text content blocks are ignored in the summary", () => {
    const state = newCloudTerminalState();
    const evt = {
      type: "agent.message",
      content: [
        { type: "text", text: "kept" },
        { type: "tool_use", id: "t1" },
      ],
    } as unknown as CloudStreamEvent;
    detectTerminal(state, evt, WALL, CAPS);
    expect(state.agentMessageParts).toEqual(["kept"]);
  });

  test("session.error stores lastError but is not terminal", () => {
    const state = newCloudTerminalState();
    const result = detectTerminal(
      state,
      makeErrorEvent("billing_error", "out of credits"),
      WALL,
      CAPS,
    );
    expect(result).toBeUndefined();
    expect(state.lastError).toMatchObject({
      type: "session.error",
      error: { type: "billing_error" },
    });
  });
});

describe("detectTerminal — session.status_idle", () => {
  test("end_turn → succeeded with accumulated summary", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeAgentMessageEvent(["part one"]), WALL, CAPS);
    detectTerminal(state, makeAgentMessageEvent(["part two"]), WALL, CAPS);
    const result = detectTerminal(state, makeIdleEvent("end_turn"), WALL, CAPS);
    expect(result).toMatchObject({
      status: "succeeded",
      summary: "part one\n\npart two",
      durationMs: WALL,
      branches: [],
    });
  });

  test("end_turn without any agent.message → succeeded without summary field", () => {
    const state = newCloudTerminalState();
    const result = detectTerminal(state, makeIdleEvent("end_turn"), WALL, CAPS);
    expect(result).toMatchObject({ status: "succeeded", durationMs: WALL });
    expect(result?.summary).toBeUndefined();
  });

  test("retries_exhausted → failed budget-exceeded", () => {
    const state = newCloudTerminalState();
    const result = detectTerminal(state, makeIdleEvent("retries_exhausted"), WALL, CAPS);
    expect(result).toMatchObject({
      status: "failed",
      failureCategory: "budget-exceeded",
      sdkTerminalStatus: "session.status_idle:retries_exhausted",
    });
  });

  test("requires_action → failed (unattended)", () => {
    const state = newCloudTerminalState();
    const result = detectTerminal(state, makeIdleEvent("requires_action"), WALL, CAPS);
    expect(result).toMatchObject({
      status: "failed",
      sdkTerminalStatus: "session.status_idle:requires_action",
    });
  });
});

describe("detectTerminal — session.status_terminated", () => {
  test("without prior error → failed unknown category", () => {
    const state = newCloudTerminalState();
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({
      status: "failed",
      sdkTerminalStatus: "session.status_terminated",
      failureCategory: "unknown",
    });
  });

  test("with prior billing_error → failed budget-exceeded", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeErrorEvent("billing_error", "credits exceeded"), WALL, CAPS);
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({
      status: "failed",
      failureCategory: "budget-exceeded",
      errorMessage: "credits exceeded",
    });
  });

  test("with prior model_overloaded_error → gateway-unreachable", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeErrorEvent("model_overloaded_error", "model busy"), WALL, CAPS);
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("with prior mcp_connection_failed_error → gateway-unreachable", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeErrorEvent("mcp_connection_failed_error", "mcp down"), WALL, CAPS);
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("with prior mcp_authentication_failed_error → gateway-unreachable", () => {
    const state = newCloudTerminalState();
    detectTerminal(
      state,
      makeErrorEvent("mcp_authentication_failed_error", "auth fail"),
      WALL,
      CAPS,
    );
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("with prior model_rate_limited_error → gateway-unreachable", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeErrorEvent("model_rate_limited_error", "rate limited"), WALL, CAPS);
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("with prior model_request_failed_error → gateway-unreachable", () => {
    const state = newCloudTerminalState();
    detectTerminal(
      state,
      makeErrorEvent("model_request_failed_error", "request failed"),
      WALL,
      CAPS,
    );
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("with prior credential_host_unreachable_error → gateway-unreachable", () => {
    const state = newCloudTerminalState();
    detectTerminal(
      state,
      makeErrorEvent("credential_host_unreachable_error", "cred host down"),
      WALL,
      CAPS,
    );
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("with prior unknown_error → sdk-throw", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeErrorEvent("unknown_error", "unknown issue"), WALL, CAPS);
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "sdk-throw" });
  });

  test("only the last session.error is used as context", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeErrorEvent("billing_error", "first"), WALL, CAPS);
    detectTerminal(state, makeErrorEvent("model_overloaded_error", "last"), WALL, CAPS);
    const result = detectTerminal(state, makeTerminatedEvent(), WALL, CAPS);
    // last error wins — model_overloaded → gateway-unreachable
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable", errorMessage: "last" });
  });
});

describe("detectTerminal — session.deleted", () => {
  test("deleted without prior error → failed sdk-throw", () => {
    const state = newCloudTerminalState();
    const result = detectTerminal(state, makeDeletedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ status: "failed", failureCategory: "sdk-throw" });
  });

  test("deleted with prior billing_error → budget-exceeded", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeErrorEvent("billing_error", "billing"), WALL, CAPS);
    const result = detectTerminal(state, makeDeletedEvent(), WALL, CAPS);
    expect(result).toMatchObject({ status: "failed", failureCategory: "budget-exceeded" });
  });
});

describe("detectTerminal — unrecognized event type", () => {
  test("unknown event type passes through (returns undefined)", () => {
    const state = newCloudTerminalState();
    const result = detectTerminal(
      state,
      { type: "span.model_request_start" } as unknown as CloudStreamEvent,
      WALL,
      CAPS,
    );
    expect(result).toBeUndefined();
  });
});

describe("mapCloudStreamEnded", () => {
  test("no prior error → failed sdk-throw", () => {
    const state = newCloudTerminalState();
    const result = mapCloudStreamEnded(state, WALL, CAPS);
    expect(result).toMatchObject({
      status: "failed",
      failureCategory: "sdk-throw",
      sdkTerminalStatus: "stream-ended-without-terminal",
    });
  });

  test("prior billing_error → budget-exceeded", () => {
    const state = newCloudTerminalState();
    detectTerminal(state, makeErrorEvent("billing_error", "billing"), WALL, CAPS);
    const result = mapCloudStreamEnded(state, WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "budget-exceeded" });
  });

  test("durationMs is preserved", () => {
    const state = newCloudTerminalState();
    const result = mapCloudStreamEnded(state, 9_999, CAPS);
    expect(result.durationMs).toBe(9_999);
  });
});

describe("mapCloudStreamThrow", () => {
  test("ECONNREFUSED → gateway-unreachable", () => {
    const result = mapCloudStreamThrow(new Error("connect ECONNREFUSED 127.0.0.1:443"), WALL, CAPS);
    expect(result).toMatchObject({ status: "failed", failureCategory: "gateway-unreachable" });
  });

  test("ENOTFOUND → gateway-unreachable", () => {
    const result = mapCloudStreamThrow(
      new Error("getaddrinfo ENOTFOUND api.anthropic.com"),
      WALL,
      CAPS,
    );
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("ECONNRESET → gateway-unreachable", () => {
    const result = mapCloudStreamThrow(new Error("read ECONNRESET"), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("ETIMEDOUT → gateway-unreachable", () => {
    const result = mapCloudStreamThrow(new Error("connect ETIMEDOUT"), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("fetch failed → gateway-unreachable", () => {
    const result = mapCloudStreamThrow(new Error("fetch failed"), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("beta header stripped 400 → gateway-unreachable", () => {
    const result = mapCloudStreamThrow(new Error("400: beta header required"), WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("HTTP 502 via status field → gateway-unreachable", () => {
    const sdkErr = Object.assign(new Error("Bad Gateway"), { status: 502 });
    const result = mapCloudStreamThrow(sdkErr, WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("HTTP 500 → gateway-unreachable (server error)", () => {
    const sdkErr = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const result = mapCloudStreamThrow(sdkErr, WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("HTTP 400 → sdk-throw (client error, not a gateway failure)", () => {
    const sdkErr = Object.assign(new Error("Bad Request"), { status: 400 });
    const result = mapCloudStreamThrow(sdkErr, WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "sdk-throw" });
  });

  test("HTTP 503 → gateway-unreachable", () => {
    const sdkErr = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const result = mapCloudStreamThrow(sdkErr, WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("HTTP 504 → gateway-unreachable", () => {
    const sdkErr = Object.assign(new Error("Gateway Timeout"), { status: 504 });
    const result = mapCloudStreamThrow(sdkErr, WALL, CAPS);
    expect(result).toMatchObject({ failureCategory: "gateway-unreachable" });
  });

  test("generic error → sdk-throw", () => {
    const result = mapCloudStreamThrow(new Error("unexpected crash"), WALL, CAPS);
    expect(result).toMatchObject({
      failureCategory: "sdk-throw",
      sdkTerminalStatus: "stream-throw",
    });
  });

  test("non-Error value → sdk-throw with stringified message", () => {
    const result = mapCloudStreamThrow("plain string error", WALL, CAPS);
    expect(result).toMatchObject({ status: "failed", failureCategory: "sdk-throw" });
    expect(result.errorMessage).toBe("plain string error");
  });

  test("durationMs is preserved", () => {
    const result = mapCloudStreamThrow(new Error("x"), 4321, CAPS);
    expect(result.durationMs).toBe(4321);
  });
});

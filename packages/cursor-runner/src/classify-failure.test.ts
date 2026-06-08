/** Table-driven tests for `classifyFailure` and `buildFailureDetail`. */

import type { SDKMessage } from "@cursor/sdk";

import { LOCAL_RUN_CONTENTION_HINT } from "@ship/workflow";
import { describe, expect, test } from "vitest";

import {
  buildFailureDetail,
  classifyFailure,
  formatClassifiedErrorMessage,
} from "./classify-failure.js";

const CAP_MS = 30 * 60 * 1000;

describe("classifyFailure", () => {
  test("empty events with no signals → unknown", () => {
    expect(classifyFailure({ events: [] })).toBe("unknown");
  });

  test("isStoreContention → contention (beats thrownError)", () => {
    expect(classifyFailure({ events: [], isStoreContention: true, thrownError: true })).toBe(
      "contention",
    );
  });

  test("thrownError → sdk-throw", () => {
    expect(classifyFailure({ events: [], thrownError: true })).toBe("sdk-throw");
  });

  test("latest failed tool_call → logic (failed status + name fallback)", () => {
    const events = [
      { type: "tool_call", status: "failed", name: "grep" },
    ] as unknown as SDKMessage[];
    expect(classifyFailure({ events })).toBe("logic");
  });

  test("latest failed tool_call → logic (error with result text)", () => {
    const events = [
      { type: "tool_call", status: "error", result: "first failure" },
      { type: "status", status: "ERROR" },
      { type: "tool_call", status: "failed", result: "latest failure" },
    ] as unknown as SDKMessage[];
    expect(classifyFailure({ events })).toBe("logic");
  });

  test("running tool_call near cap with age > 30s → agent-collapse-on-running-tool", () => {
    const events = [
      {
        type: "tool_call",
        status: "running",
        name: "shell",
        ts: "2026-06-01T12:00:00.000Z",
      },
      { type: "status", status: "ERROR", ts: "2026-06-01T12:25:00.000Z" },
    ] as unknown as SDKMessage[];
    expect(
      classifyFailure({
        durationMs: 25 * 60 * 1000,
        events,
        maxRunDurationMs: CAP_MS,
      }),
    ).toBe("agent-collapse-on-running-tool");
  });

  test("running tool_call without timestamps falls back to durationMs for age", () => {
    const events = [
      { type: "tool_call", status: "running", name: "shell" },
    ] as unknown as SDKMessage[];
    expect(
      classifyFailure({
        durationMs: 25 * 60 * 1000,
        events,
        maxRunDurationMs: CAP_MS,
      }),
    ).toBe("agent-collapse-on-running-tool");
  });

  test("running tool_call later completed (same call_id) is not agent-collapse", () => {
    const events = [
      {
        type: "tool_call",
        status: "running",
        name: "shell",
        call_id: "c1",
        ts: "2026-06-01T12:00:00.000Z",
      },
      {
        type: "tool_call",
        status: "completed",
        name: "shell",
        call_id: "c1",
        ts: "2026-06-01T12:05:00.000Z",
      },
    ] as unknown as SDKMessage[];
    // The tool finished — no running tool_call remains, so a long run is not a
    // collapse. 0.85×cap is collapse-duration but below near-cap → unknown.
    expect(classifyFailure({ durationMs: 0.85 * CAP_MS, events, maxRunDurationMs: CAP_MS })).toBe(
      "unknown",
    );
  });

  test("a still-running call_id is agent-collapse even when another completed", () => {
    const events = [
      {
        type: "tool_call",
        status: "completed",
        name: "grep",
        call_id: "c1",
        ts: "2026-06-01T12:00:00.000Z",
      },
      {
        type: "tool_call",
        status: "running",
        name: "shell",
        call_id: "c2",
        ts: "2026-06-01T12:01:00.000Z",
      },
      { type: "status", status: "ERROR", ts: "2026-06-01T12:25:00.000Z" },
    ] as unknown as SDKMessage[];
    expect(classifyFailure({ durationMs: 25 * 60 * 1000, events, maxRunDurationMs: CAP_MS })).toBe(
      "agent-collapse-on-running-tool",
    );
  });

  test("sdkTerminalStatus expired (any case) → timeout-near-cap", () => {
    expect(classifyFailure({ events: [], sdkTerminalStatus: "EXPIRED" })).toBe("timeout-near-cap");
    expect(classifyFailure({ events: [], sdkTerminalStatus: "expired" })).toBe("timeout-near-cap");
  });

  test("durationMs ≥ 0.95×cap → timeout-near-cap", () => {
    expect(
      classifyFailure({
        durationMs: 0.96 * CAP_MS,
        events: [],
        maxRunDurationMs: CAP_MS,
      }),
    ).toBe("timeout-near-cap");
  });

  test("never returns undefined", () => {
    const category = classifyFailure({ events: [] });
    expect(category).toBeDefined();
    expect(typeof category).toBe("string");
  });
});

describe("buildFailureDetail", () => {
  test("logic category uses failed tool_call detail", () => {
    const events = [
      { type: "tool_call", status: "error", result: "database is locked" },
    ] as unknown as SDKMessage[];
    expect(
      buildFailureDetail({
        category: "logic",
        events,
      }),
    ).toBe("database is locked");
  });

  test("logic fallback paths", () => {
    expect(
      buildFailureDetail({
        category: "logic",
        events: [],
        rawErrorMessage: "runner message",
      }),
    ).toBe("runner message");
    expect(buildFailureDetail({ category: "logic", events: [] })).toBe("tool_call failed");
  });

  test("contention uses hint from thrown error when present", () => {
    const err = new Error(`${LOCAL_RUN_CONTENTION_HINT} (database is locked)`);
    expect(
      buildFailureDetail({
        category: "contention",
        events: [],
        thrownErr: err,
      }),
    ).toBe(err.message);
    expect(buildFailureDetail({ category: "contention", events: [] })).toBe(
      LOCAL_RUN_CONTENTION_HINT,
    );
  });

  test("sdk-throw detail paths", () => {
    expect(
      buildFailureDetail({
        category: "sdk-throw",
        events: [],
        thrownErr: new Error("Agent.create failed"),
      }),
    ).toBe("Agent.create failed");
    expect(
      buildFailureDetail({
        category: "sdk-throw",
        events: [],
        rawErrorMessage: "raw only",
      }),
    ).toBe("raw only");
    expect(buildFailureDetail({ category: "sdk-throw", events: [] })).toBe(
      "SDK error before terminal result",
    );
  });

  test("agent-collapse describes the running tool", () => {
    const events = [
      {
        type: "tool_call",
        status: "running",
        name: "shell",
        ts: "2026-06-01T12:00:00.000Z",
      },
      { type: "status", status: "ERROR", ts: "2026-06-01T12:04:12.000Z" },
    ] as unknown as SDKMessage[];
    expect(
      buildFailureDetail({
        category: "agent-collapse-on-running-tool",
        durationMs: 252_000,
        events,
        maxRunDurationMs: CAP_MS,
      }),
    ).toContain("shell");
    expect(
      buildFailureDetail({
        category: "agent-collapse-on-running-tool",
        durationMs: 252_000,
        events,
        maxRunDurationMs: CAP_MS,
      }),
    ).toContain("never completed");
    expect(buildFailureDetail({ category: "agent-collapse-on-running-tool", events: [] })).toBe(
      "agent stopped with a running tool_call",
    );
  });

  test("timeout-near-cap detail with and without cap", () => {
    expect(
      buildFailureDetail({
        category: "timeout-near-cap",
        durationMs: CAP_MS,
        events: [],
        maxRunDurationMs: CAP_MS,
        sdkTerminalStatus: "EXPIRED",
      }),
    ).toContain("SDK status expired");
    expect(
      buildFailureDetail({
        category: "timeout-near-cap",
        durationMs: 60_000,
        events: [],
      }),
    ).toBe("duration 1m");
  });

  test("unknown detail paths", () => {
    expect(
      buildFailureDetail({
        category: "unknown",
        events: [],
        rawErrorMessage: "opaque",
      }),
    ).toBe("opaque");
    expect(
      buildFailureDetail({
        category: "unknown",
        events: [],
        sdkTerminalStatus: "ERROR",
      }),
    ).toBe("SDK status ERROR");
    expect(buildFailureDetail({ category: "unknown", events: [] })).toBe(
      "no classification signals",
    );
  });

  test("formatClassifiedErrorMessage prefixes category", () => {
    expect(formatClassifiedErrorMessage("logic", "make check failed")).toBe(
      "logic; make check failed",
    );
  });

  test("buildFailureDetail caps long tool output", () => {
    const longErr = "x".repeat(600);
    const detail = buildFailureDetail({
      category: "logic",
      events: [{ type: "tool_call", status: "error", result: longErr }] as never[],
    });
    expect(detail.length).toBe(512);
    expect(detail.endsWith("...")).toBe(true);
  });
});

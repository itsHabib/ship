/** Table-driven tests for projection-based `classifyFailure` and `buildFailureDetail`. */

import { LOCAL_RUN_CONTENTION_HINT } from "@ship/workflow";
import { describe, expect, test } from "vitest";

import {
  buildFailureDetail,
  classifyFailure,
  formatClassifiedErrorMessage,
} from "./classify-failure.js";
import { testEventProjection } from "./test-projection.js";

const CAP_MS = 30 * 60 * 1000;
const projection = testEventProjection;

describe("classifyFailure", () => {
  test("empty events with no signals → unknown", () => {
    expect(classifyFailure({ events: [], projection })).toBe("unknown");
  });

  test("isStoreContention → contention (beats thrownError)", () => {
    expect(
      classifyFailure({ events: [], isStoreContention: true, projection, thrownError: true }),
    ).toBe("contention");
  });

  test("thrownError → sdk-throw", () => {
    expect(classifyFailure({ events: [], projection, thrownError: true })).toBe("sdk-throw");
  });

  test("latest failed tool_call → logic", () => {
    const events = [{ type: "tool_call", status: "failed", name: "grep" }];
    expect(classifyFailure({ events, projection })).toBe("logic");
  });

  test("running tool_call near cap → agent-collapse-on-running-tool", () => {
    const events = [
      { type: "tool_call", status: "running", name: "shell", ts: "2026-06-01T12:00:00.000Z" },
      { type: "status", status: "ERROR", ts: "2026-06-01T12:25:00.000Z" },
    ];
    expect(
      classifyFailure({
        durationMs: 25 * 60 * 1000,
        events,
        maxRunDurationMs: CAP_MS,
        projection,
      }),
    ).toBe("agent-collapse-on-running-tool");
  });

  test("sdkTerminalStatus expired (any case) → timeout-near-cap", () => {
    expect(classifyFailure({ events: [], projection, sdkTerminalStatus: "EXPIRED" })).toBe(
      "timeout-near-cap",
    );
    expect(classifyFailure({ events: [], projection, sdkTerminalStatus: "expired" })).toBe(
      "timeout-near-cap",
    );
  });

  test("latest failed tool_call → logic (error with result text)", () => {
    const events = [
      { type: "tool_call", status: "error", result: "first failure" },
      { type: "status", status: "ERROR" },
      { type: "tool_call", status: "failed", result: "latest failure" },
    ];
    expect(classifyFailure({ events, projection })).toBe("logic");
  });

  test("running tool_call without timestamps falls back to durationMs for age", () => {
    const events = [{ type: "tool_call", status: "running", name: "shell" }];
    expect(
      classifyFailure({
        durationMs: 25 * 60 * 1000,
        events,
        maxRunDurationMs: CAP_MS,
        projection,
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
    ];
    expect(
      classifyFailure({ durationMs: 0.85 * CAP_MS, events, maxRunDurationMs: CAP_MS, projection }),
    ).toBe("unknown");
  });

  test("durationMs ≥ 0.95×cap → timeout-near-cap", () => {
    expect(
      classifyFailure({
        durationMs: 0.96 * CAP_MS,
        events: [],
        maxRunDurationMs: CAP_MS,
        projection,
      }),
    ).toBe("timeout-near-cap");
  });

  test("never returns undefined", () => {
    const category = classifyFailure({ events: [], projection });
    expect(category).toBeDefined();
    expect(typeof category).toBe("string");
  });
});

describe("buildFailureDetail", () => {
  test("logic category uses failed tool_call detail", () => {
    const events = [{ type: "tool_call", status: "error", result: "database is locked" }];
    expect(buildFailureDetail({ category: "logic", events, projection })).toBe(
      "database is locked",
    );
  });

  test("formatClassifiedErrorMessage prefixes category", () => {
    expect(formatClassifiedErrorMessage("logic", "make check failed")).toBe(
      "logic; make check failed",
    );
  });

  test("contention uses hint from thrown error when present", () => {
    const err = new Error(`${LOCAL_RUN_CONTENTION_HINT} (database is locked)`);
    expect(
      buildFailureDetail({
        category: "contention",
        events: [],
        projection,
        thrownErr: err,
      }),
    ).toBe(err.message);
    expect(buildFailureDetail({ category: "contention", events: [], projection })).toBe(
      LOCAL_RUN_CONTENTION_HINT,
    );
  });

  test("logic fallback paths", () => {
    expect(
      buildFailureDetail({
        category: "logic",
        events: [],
        projection,
        rawErrorMessage: "runner message",
      }),
    ).toBe("runner message");
    expect(buildFailureDetail({ category: "logic", events: [], projection })).toBe(
      "tool_call failed",
    );
  });

  test("sdk-throw detail paths", () => {
    expect(
      buildFailureDetail({
        category: "sdk-throw",
        events: [],
        projection,
        thrownErr: new Error("Agent.create failed"),
      }),
    ).toBe("Agent.create failed");
    expect(
      buildFailureDetail({
        category: "sdk-throw",
        events: [],
        projection,
        rawErrorMessage: "raw only",
      }),
    ).toBe("raw only");
    expect(buildFailureDetail({ category: "sdk-throw", events: [], projection })).toBe(
      "SDK error before terminal result",
    );
  });

  test("agent-collapse describes the running tool", () => {
    const events = [
      {
        type: "tool_call",
        status: "running",
        name: "shell",
        args: { command: "make check" },
        ts: "2026-06-01T12:00:00.000Z",
      },
      { type: "status", status: "ERROR", ts: "2026-06-01T12:04:12.000Z" },
    ];
    const detail = buildFailureDetail({
      category: "agent-collapse-on-running-tool",
      durationMs: 252_000,
      events,
      maxRunDurationMs: CAP_MS,
      projection,
    });
    expect(detail).toContain("shell 'make check'");
    expect(detail).toContain("never completed");
    expect(
      buildFailureDetail({ category: "agent-collapse-on-running-tool", events: [], projection }),
    ).toBe("agent stopped with a running tool_call");
  });

  test("timeout-near-cap detail with and without cap", () => {
    expect(
      buildFailureDetail({
        category: "timeout-near-cap",
        durationMs: CAP_MS,
        events: [],
        maxRunDurationMs: CAP_MS,
        projection,
        sdkTerminalStatus: "EXPIRED",
      }),
    ).toContain("SDK status expired");
    expect(
      buildFailureDetail({
        category: "timeout-near-cap",
        durationMs: 60_000,
        events: [],
        projection,
      }),
    ).toBe("duration 1m");
  });

  test("unknown detail paths", () => {
    expect(
      buildFailureDetail({
        category: "unknown",
        events: [],
        projection,
        rawErrorMessage: "opaque",
      }),
    ).toBe("opaque");
    expect(
      buildFailureDetail({
        category: "unknown",
        events: [],
        projection,
        sdkTerminalStatus: "ERROR",
      }),
    ).toBe("SDK status ERROR");
    expect(buildFailureDetail({ category: "unknown", events: [], projection })).toBe(
      "no classification signals",
    );
  });

  test("buildFailureDetail caps long tool output", () => {
    const longErr = "x".repeat(600);
    const detail = buildFailureDetail({
      category: "logic",
      events: [{ type: "tool_call", status: "error", result: longErr }],
      projection,
    });
    expect(detail.length).toBe(512);
    expect(detail.endsWith("...")).toBe(true);
  });

  test("gateway-unreachable detail paths", () => {
    expect(
      buildFailureDetail({
        category: "gateway-unreachable",
        events: [],
        projection,
        thrownErr: new Error("fetch failed"),
      }),
    ).toBe("fetch failed");
    expect(
      buildFailureDetail({
        category: "gateway-unreachable",
        events: [],
        projection,
        rawErrorMessage: "gateway 502",
      }),
    ).toBe("gateway 502");
    expect(buildFailureDetail({ category: "gateway-unreachable", events: [], projection })).toBe(
      "gateway unreachable",
    );
  });

  test("budget-exceeded detail paths", () => {
    expect(
      buildFailureDetail({
        category: "budget-exceeded",
        events: [],
        projection,
        sdkTerminalStatus: "error_max_turns",
      }),
    ).toBe("SDK status error_max_turns");
    expect(
      buildFailureDetail({
        category: "budget-exceeded",
        events: [],
        projection,
        rawErrorMessage: "cap hit",
      }),
    ).toBe("cap hit");
    expect(buildFailureDetail({ category: "budget-exceeded", events: [], projection })).toBe(
      "configured budget or turn cap exceeded",
    );
  });

  test("sandbox-denial detail paths", () => {
    expect(
      buildFailureDetail({
        category: "sandbox-denial",
        events: [],
        projection,
        rawErrorMessage: "sandbox policy blocked rm",
      }),
    ).toBe("sandbox policy blocked rm");
    expect(buildFailureDetail({ category: "sandbox-denial", events: [], projection })).toBe(
      "command blocked by sandbox policy",
    );
  });

  test("patch-apply-fail detail paths", () => {
    expect(
      buildFailureDetail({
        category: "patch-apply-fail",
        events: [],
        projection,
        rawErrorMessage: "patch conflict",
      }),
    ).toBe("patch conflict");
    expect(buildFailureDetail({ category: "patch-apply-fail", events: [], projection })).toBe(
      "file patch failed to apply",
    );
  });
});

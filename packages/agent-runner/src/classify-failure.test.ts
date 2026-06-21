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

  test("sdkTerminalStatus expired → timeout-near-cap", () => {
    expect(classifyFailure({ events: [], projection, sdkTerminalStatus: "expired" })).toBe(
      "timeout-near-cap",
    );
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
  });
});

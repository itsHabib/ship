/** Table-driven tests for bounded SDK-cause formatting + fold helpers. */

import { describe, expect, test } from "vitest";

import { AgentRunFailedError } from "./errors.js";
import {
  causeSummaryFromThrown,
  foldSdkCauseIntoDetail,
  formatSdkCauseSuffix,
  MAX_FOLDED_DETAIL_CHARS,
  MAX_SDK_CAUSE_DETAIL_CHARS,
  type SdkCauseSummary,
} from "./sdk-cause.js";

describe("formatSdkCauseSuffix", () => {
  test("formats status + code + request_id", () => {
    expect(
      formatSdkCauseSuffix({
        code: "invalid_request_error",
        requestId: "req_abc",
        status: 400,
      }),
    ).toBe("HTTP 400 invalid_request_error, request_id req_abc");
  });

  test("uses type when code is absent", () => {
    expect(formatSdkCauseSuffix({ status: 429, type: "rate_limit" })).toBe("HTTP 429 rate_limit");
  });

  test("message-only when discriminating fields are absent", () => {
    expect(formatSdkCauseSuffix({ message: "boom only" })).toBe("boom only");
  });

  test("returns empty string for an empty summary", () => {
    expect(formatSdkCauseSuffix({})).toBe("");
  });

  test("truncates at the length cap", () => {
    const long = "x".repeat(MAX_SDK_CAUSE_DETAIL_CHARS + 40);
    const out = formatSdkCauseSuffix({ message: long });
    expect(out.length).toBe(MAX_SDK_CAUSE_DETAIL_CHARS);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("foldSdkCauseIntoDetail", () => {
  test("appends parenthetical cause onto the base detail", () => {
    const cause: SdkCauseSummary = {
      code: "invalid_request_error",
      requestId: "req_1",
      status: 400,
    };
    expect(foldSdkCauseIntoDetail("agent.send failed after Agent.create", cause)).toBe(
      "agent.send failed after Agent.create (HTTP 400 invalid_request_error, request_id req_1)",
    );
  });

  test("no-op when cause is undefined or empty", () => {
    expect(foldSdkCauseIntoDetail("base", undefined)).toBe("base");
    expect(foldSdkCauseIntoDetail("base", {})).toBe("base");
  });

  test("returns suffix alone when detail is empty", () => {
    expect(foldSdkCauseIntoDetail("", { status: 503, code: "upstream" })).toBe("HTTP 503 upstream");
  });

  test("re-bounds the combined detail so fold cannot bypass the 512-char invariant", () => {
    const longBase = "b".repeat(500);
    const folded = foldSdkCauseIntoDetail(longBase, {
      code: "invalid_request_error",
      requestId: "req_overflow",
      status: 400,
    });
    expect(folded.length).toBe(MAX_FOLDED_DETAIL_CHARS);
    expect(folded.endsWith("...")).toBe(true);
  });
});

describe("causeSummaryFromThrown", () => {
  test("reads causeSummary off AgentRunFailedError", () => {
    const err = new AgentRunFailedError("agent.send failed after Agent.create", {
      causeSummary: { status: 400, code: "invalid_request_error", requestId: "req_z" },
    });
    expect(causeSummaryFromThrown(err)).toEqual({
      status: 400,
      code: "invalid_request_error",
      requestId: "req_z",
    });
  });

  test("returns undefined for plain Errors", () => {
    expect(causeSummaryFromThrown(new Error("boom"))).toBeUndefined();
  });
});

/** Tests for `errors.ts` — ED-4 error-code mapping pinned per task doc. */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  MissingRepoError,
  WorkdirNotFoundError,
} from "@ship/core";
import { WorkflowRunNotFoundError } from "@ship/store";
import { describe, expect, test } from "vitest";

import { isUserError, mapErrorToMcpError } from "./errors.js";

describe("isUserError", () => {
  test("typed pre-row errors from core map to user errors", () => {
    expect(isUserError(new WorkdirNotFoundError("/nope"))).toBe(true);
    expect(isUserError(new DocNotFoundError("missing.md"))).toBe(true);
    expect(isUserError(new DocPathEscapesWorkdirError("/work", "../escape"))).toBe(true);
    expect(isUserError(new MissingRepoError())).toBe(true);
  });

  test("WorkflowRunNotFoundError (cancel/getRun on unknown id) is a user error", () => {
    expect(isUserError(new WorkflowRunNotFoundError("wf_unknown"))).toBe(true);
  });

  test("RangeError (e.g. listRuns limit cap exceeded) is a user error", () => {
    expect(
      isUserError(new RangeError("limit 99999999 exceeds the maximum allowed value 200")),
    ).toBe(true);
  });

  test("Zod errors (by name) map to user errors", () => {
    const e = new Error("invalid input");
    e.name = "ZodError";
    expect(isUserError(e)).toBe(true);
  });

  test("generic Error / non-Error does not map to user error (falls to internal)", () => {
    expect(isUserError(new Error("something blew up"))).toBe(false);
    expect(isUserError("string thrown")).toBe(false);
    expect(isUserError(undefined)).toBe(false);
  });
});

describe("mapErrorToMcpError", () => {
  test("typed user errors map to InvalidParams (-32602)", () => {
    const out = mapErrorToMcpError(new WorkdirNotFoundError("/nope"));
    expect(out).toBeInstanceOf(McpError);
    expect(out.code).toBe(ErrorCode.InvalidParams);
    expect(out.message).toMatch(/\/nope/);
  });

  test("WorkflowRunNotFoundError maps to InvalidParams", () => {
    const out = mapErrorToMcpError(new WorkflowRunNotFoundError("wf_unknown"));
    expect(out.code).toBe(ErrorCode.InvalidParams);
  });

  test("generic Error maps to InternalError (-32603)", () => {
    const out = mapErrorToMcpError(new Error("kaboom"));
    expect(out.code).toBe(ErrorCode.InternalError);
    expect(out.message).toMatch(/kaboom/);
  });

  test("McpError pass-through preserves the original code (no double-wrap)", () => {
    const original = new McpError(ErrorCode.InvalidParams, "specific message");
    const out = mapErrorToMcpError(original);
    expect(out).toBe(original);
  });

  test("non-Error values stringify into the message", () => {
    const out = mapErrorToMcpError("string thrown");
    expect(out.code).toBe(ErrorCode.InternalError);
    // McpError prefixes with `MCP error <code>: `; assert the payload
    // suffix rather than exact equality so a future SDK prefix change
    // doesn't false-fail this test.
    expect(out.message).toMatch(/string thrown$/);
  });
});

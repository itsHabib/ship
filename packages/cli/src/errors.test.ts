/** Tests for `errors.ts` — exit-code mapping pinned per spec.md. */

import { DocNotFoundError, DocPathEscapesWorkdirError, WorkdirNotFoundError } from "@ship/core";
import { WorkflowRunNotFoundError } from "@ship/store";
import { describe, expect, test } from "vitest";

import {
  CliExit,
  cliExit,
  InvalidArgumentError,
  isUserError,
  mapErrorToExitCode,
} from "./errors.js";

describe("isUserError", () => {
  test("typed pre-row errors from core map to user errors", () => {
    expect(isUserError(new WorkdirNotFoundError("/nope"))).toBe(true);
    expect(isUserError(new DocNotFoundError("missing.md"))).toBe(true);
    expect(isUserError(new DocPathEscapesWorkdirError("/work", "../escape"))).toBe(true);
  });

  test("Commander 'missing required option' messages map to user errors", () => {
    expect(isUserError(new Error("missing required option: --repo"))).toBe(true);
    expect(isUserError(new Error("error: unknown option '--banana'"))).toBe(true);
    expect(isUserError(new Error("too few arguments"))).toBe(true);
  });

  test("Zod errors (by name) map to user errors", () => {
    const e = new Error("invalid input");
    e.name = "ZodError";
    expect(isUserError(e)).toBe(true);
  });

  test("WorkflowRunNotFoundError (cancel/getRun on unknown id) is a user error", () => {
    expect(isUserError(new WorkflowRunNotFoundError("wf_unknown"))).toBe(true);
  });

  test("InvalidArgumentError (CLI argv-parse rejection) is a user error", () => {
    expect(isUserError(new InvalidArgumentError("--limit foo"))).toBe(true);
  });

  test("RangeError (e.g. listRuns limit cap exceeded) is a user error", () => {
    expect(isUserError(new RangeError("limit 99999999 exceeds maximum 200"))).toBe(true);
  });

  test("generic Error / non-Error does not map to user error (falls to internal)", () => {
    expect(isUserError(new Error("something blew up"))).toBe(false);
    expect(isUserError("string thrown")).toBe(false);
    expect(isUserError(undefined)).toBe(false);
  });
});

describe("mapErrorToExitCode", () => {
  test("user error → 1, internal → 2", () => {
    expect(mapErrorToExitCode(new WorkdirNotFoundError("/x"))).toBe(1);
    expect(mapErrorToExitCode(new Error("internal"))).toBe(2);
  });
});

describe("cliExit / CliExit", () => {
  test("cliExit throws a CliExit carrying the supplied code", () => {
    expect(() => {
      cliExit(2, "boom");
    }).toThrow(CliExit);
    try {
      cliExit(2, "boom");
    } catch (err) {
      expect(err).toBeInstanceOf(CliExit);
      expect((err as CliExit).code).toBe(2);
      expect((err as CliExit).message).toBe("boom");
    }
  });

  test("CliExit default message includes the code", () => {
    expect(new CliExit(1).message).toBe("cli exit 1");
  });
});

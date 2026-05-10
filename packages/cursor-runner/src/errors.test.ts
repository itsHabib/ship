/** Tests for `errors.ts` — pin the shape so renames/message-changes fail loud. */

import { describe, expect, test } from "vitest";

import { CursorRunFailedError, MissingApiKeyError } from "./errors.js";

describe("MissingApiKeyError", () => {
  test("is an Error subclass with the expected name and message", () => {
    const err = new MissingApiKeyError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MissingApiKeyError);
    expect(err.name).toBe("MissingApiKeyError");
    expect(err.message).toMatch(/CURSOR_API_KEY/);
  });

  test("is discriminable from CursorRunFailedError via instanceof", () => {
    const err: Error = new MissingApiKeyError();
    expect(err instanceof CursorRunFailedError).toBe(false);
  });
});

describe("CursorRunFailedError", () => {
  test("is an Error subclass with the expected name", () => {
    const err = new CursorRunFailedError("agent.send threw");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CursorRunFailedError);
    expect(err.name).toBe("CursorRunFailedError");
    expect(err.message).toBe("agent.send threw");
  });

  test("preserves the original SDK error in cause", () => {
    const sdkError = new Error("AuthenticationError: bad key");
    const wrapped = new CursorRunFailedError("Agent.create rejected", { cause: sdkError });
    expect(wrapped.cause).toBe(sdkError);
  });

  test("works without a cause (plain message-only construction)", () => {
    const err = new CursorRunFailedError("something broke");
    expect(err.cause).toBeUndefined();
  });

  test("is discriminable from MissingApiKeyError via instanceof", () => {
    const err: Error = new CursorRunFailedError("x");
    expect(err instanceof MissingApiKeyError).toBe(false);
  });
});

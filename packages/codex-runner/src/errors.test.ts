/** Tests for `errors.ts`. */

import { describe, expect, test } from "vitest";

import {
  MissingApiKeyError,
  OperationNotSupportedError,
  UnsupportedPlatformError,
  WrongRunnerError,
} from "./errors.js";

describe("OperationNotSupportedError", () => {
  test("carries a clear attach message", () => {
    const err = new OperationNotSupportedError(
      "Codex local runner does not support attach; use run()",
    );
    expect(err.name).toBe("OperationNotSupportedError");
    expect(err.message).toContain("does not support attach");
  });
});

describe("UnsupportedPlatformError", () => {
  test("names the platform and arch", () => {
    const err = new UnsupportedPlatformError("freebsd", "x64");
    expect(err.name).toBe("UnsupportedPlatformError");
    expect(err.message).toContain("freebsd/x64");
  });
});

describe("WrongRunnerError", () => {
  test("is a MissingApiKeyError sibling under AgentRunFailedError", () => {
    const err = new WrongRunnerError("bad runtime");
    expect(err).toBeInstanceOf(WrongRunnerError);
    expect(err).not.toBeInstanceOf(MissingApiKeyError);
  });
});

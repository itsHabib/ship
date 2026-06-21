/** Tests for `errors.ts` — pin the shape so renames/message-changes fail loud. */

import { describe, expect, test } from "vitest";

import {
  AgentRunFailedError,
  agentRunFailedError,
  CursorAgentNotFoundError,
  LocalResumeNotSupportedError,
  MissingApiKeyError,
} from "./errors.js";

describe("MissingApiKeyError", () => {
  test("is an Error subclass with the expected name and message", () => {
    const err = new MissingApiKeyError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MissingApiKeyError);
    expect(err.name).toBe("MissingApiKeyError");
    expect(err.message).toMatch(/CURSOR_API_KEY/);
  });

  test("is discriminable from AgentRunFailedError via instanceof", () => {
    const err: Error = new MissingApiKeyError();
    expect(err instanceof AgentRunFailedError).toBe(false);
  });
});

describe("AgentRunFailedError", () => {
  test("is an Error subclass with the expected name", () => {
    const err = new AgentRunFailedError("agent.send threw");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentRunFailedError);
    expect(err.name).toBe("AgentRunFailedError");
    expect(err.message).toBe("agent.send threw");
  });

  test("preserves the original SDK error in cause", () => {
    const sdkError = new Error("AuthenticationError: bad key");
    const wrapped = new AgentRunFailedError("Agent.create rejected", { cause: sdkError });
    expect(wrapped.cause).toBe(sdkError);
  });

  test("agentRunFailedError folds cause message into .message", () => {
    const sdkError = new Error("database is locked");
    const wrapped = agentRunFailedError("run.wait() rejected after a clean stream", sdkError);
    expect(wrapped.message).toContain("database is locked");
    expect(wrapped.cause).toBe(sdkError);
  });

  test("works without a cause (plain message-only construction)", () => {
    const err = new AgentRunFailedError("something broke");
    expect(err.cause).toBeUndefined();
  });

  test("is discriminable from MissingApiKeyError via instanceof", () => {
    const err: Error = new AgentRunFailedError("x");
    expect(err instanceof MissingApiKeyError).toBe(false);
  });
});

describe("CursorAgentNotFoundError", () => {
  test("is an Error subclass with agentId, runId, runtime fields", () => {
    const cause = new Error("UnknownAgentError");
    const err = new CursorAgentNotFoundError({
      agentId: "bc-abc123",
      runId: "run-xyz789",
      runtime: "cloud",
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CursorAgentNotFoundError);
    // Extends AgentRunFailedError so umbrella catch sites (e.g. phase 12's
    // resumeOrphanedRuns) pick this up alongside the run-start failures.
    expect(err).toBeInstanceOf(AgentRunFailedError);
    expect(err.name).toBe("CursorAgentNotFoundError");
    expect(err.agentId).toBe("bc-abc123");
    expect(err.runId).toBe("run-xyz789");
    expect(err.runtime).toBe("cloud");
    expect(err.cause).toBe(cause);
    expect(err.message).toMatch(/bc-abc123/);
    expect(err.message).toMatch(/run-xyz789/);
  });

  test("works without a cause", () => {
    const err = new CursorAgentNotFoundError({
      agentId: "bc-1",
      runId: "run-1",
      runtime: "local",
    });
    expect(err.cause).toBeUndefined();
    expect(err.runtime).toBe("local");
  });
});

describe("LocalResumeNotSupportedError", () => {
  test("is an Error subclass with agentId field", () => {
    const err = new LocalResumeNotSupportedError({ agentId: "agent-local-001" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LocalResumeNotSupportedError);
    // Extends AgentRunFailedError for parity with the other attach failures.
    expect(err).toBeInstanceOf(AgentRunFailedError);
    expect(err.name).toBe("LocalResumeNotSupportedError");
    expect(err.agentId).toBe("agent-local-001");
    expect(err.message).toMatch(/agent-local-001/);
    expect(err.message).toMatch(/not supported/i);
  });
});

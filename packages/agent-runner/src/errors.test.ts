/** Tests for provider-neutral error taxonomy. */

import { describe, expect, test } from "vitest";

import {
  AgentNotFoundError,
  AgentRunFailedError,
  agentRunFailedError,
  MissingApiKeyError,
} from "./errors.js";

describe("MissingApiKeyError", () => {
  test("is an Error subclass with the expected name and a provider-neutral default message", () => {
    const err = new MissingApiKeyError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MissingApiKeyError);
    expect(err.name).toBe("MissingApiKeyError");
    expect(err.message).toMatch(/API key/);
  });

  test("preserves a provider-supplied env var name in the message", () => {
    const err = new MissingApiKeyError("CURSOR_API_KEY environment variable is not set");
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

  test("preserves the original error in cause", () => {
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

  test("agentRunFailedError stringifies non-Error causes", () => {
    const wrapped = agentRunFailedError("attach failed", { code: "ENOENT" });
    expect(wrapped.message).toContain("ENOENT");
  });

  test("agentRunFailedError handles unstringifiable causes", () => {
    const wrapped = agentRunFailedError("attach failed", (): void => undefined);
    expect(wrapped.message).toContain("[unstringifiable cause]");
  });

  test("agentRunFailedError stringifies primitive causes", () => {
    expect(agentRunFailedError("x", 404).message).toContain("404");
    expect(agentRunFailedError("x", true).message).toContain("true");
  });

  test("works without a cause (plain message-only construction)", () => {
    const err = new AgentRunFailedError("something broke");
    expect(err.cause).toBeUndefined();
  });
});

describe("AgentNotFoundError", () => {
  test("is an Error subclass with agentId and runId fields", () => {
    const cause = new Error("UnknownAgentError");
    const err = new AgentNotFoundError({
      agentId: "bc-abc123",
      runId: "run-xyz789",
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentNotFoundError);
    expect(err).toBeInstanceOf(AgentRunFailedError);
    expect(err.name).toBe("AgentNotFoundError");
    expect(err.agentId).toBe("bc-abc123");
    expect(err.runId).toBe("run-xyz789");
    expect(err.cause).toBe(cause);
    expect(err.message).toMatch(/bc-abc123/);
    expect(err.message).toMatch(/run-xyz789/);
  });

  test("works without a cause", () => {
    const err = new AgentNotFoundError({ agentId: "bc-1", runId: "run-1" });
    expect(err.cause).toBeUndefined();
  });
});

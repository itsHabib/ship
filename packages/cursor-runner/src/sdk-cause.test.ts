/** Table-driven tests for named-field SDK cause extraction + redaction. */

import { describe, expect, test } from "vitest";

import { extractSdkCause, GH_MCP_URL_REDACTION } from "./sdk-cause.js";

function hiddenFieldError(message: string, fields: Record<string, unknown>): Error {
  const err = new Error(message);
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(err, key, { value, enumerable: false, configurable: true });
  }
  return err;
}

describe("extractSdkCause", () => {
  test("reads status/code/type/request_id/endpoint when present", () => {
    const err = Object.assign(new Error("bad request"), {
      code: "invalid_request_error",
      endpoint: "POST /v1/agents",
      request_id: "req_abc",
      status: 400,
      type: "invalid_request_error",
    });
    expect(extractSdkCause(err)).toEqual({
      code: "invalid_request_error",
      endpoint: "POST /v1/agents",
      message: "bad request",
      requestId: "req_abc",
      status: 400,
      type: "invalid_request_error",
    });
  });

  test("accepts camelCase requestId and statusCode / url aliases", () => {
    const err = Object.assign(new Error("alias"), {
      requestId: "req_camel",
      statusCode: 429,
      url: "https://api.example/agents",
    });
    expect(extractSdkCause(err)).toMatchObject({
      endpoint: "https://api.example/agents",
      requestId: "req_camel",
      status: 429,
    });
  });

  test("all discriminating fields absent → message-only, no fabricated fields", () => {
    expect(extractSdkCause(new Error("plain boom"))).toEqual({ message: "plain boom" });
  });

  test("empty Error with no fields → undefined", () => {
    expect(extractSdkCause(new Error(""))).toBeUndefined();
  });

  test("non-enumerable own-properties are read correctly", () => {
    const err = hiddenFieldError("hidden", {
      code: "upstream_unavailable",
      requestId: "req_hidden",
      status: 503,
    });
    expect(Object.keys(err)).not.toContain("status");
    expect(extractSdkCause(err)).toEqual({
      code: "upstream_unavailable",
      message: "hidden",
      requestId: "req_hidden",
      status: 503,
    });
  });

  test("GITHUB_MCP_URL occurrences are redacted from string fields", () => {
    const secretUrl = "https://mcp.example/github?token=ghp_secret";
    const err = Object.assign(new Error(`failed against ${secretUrl}`), {
      endpoint: `${secretUrl}/tools`,
      status: 400,
    });
    const summary = extractSdkCause(err, { githubMcpUrl: secretUrl });
    expect(summary?.endpoint).toContain(GH_MCP_URL_REDACTION);
    expect(summary?.endpoint).not.toContain("ghp_secret");
    expect(summary?.message).toContain(GH_MCP_URL_REDACTION);
    expect(summary?.message).not.toContain(secretUrl);
  });

  test("a percent-encoded GITHUB_MCP_URL with an opaque token is redacted", () => {
    // Opaque token (no ghp_/github_pat_ prefix) so the shape scrubber can't
    // catch it; fully URL-encoded so the literal-URL split misses it. The
    // encoded-form redaction is what keeps the token out of the summary.
    const secretUrl = "https://mcp.example/github?token=opaque_no_pat_prefix";
    const err = Object.assign(new Error("boom"), {
      endpoint: `failed against ${encodeURIComponent(secretUrl)}`,
      status: 400,
    });
    const summary = extractSdkCause(err, { githubMcpUrl: secretUrl });
    expect(summary?.endpoint).toContain(GH_MCP_URL_REDACTION);
    expect(summary?.endpoint).not.toContain("opaque_no_pat_prefix");
  });

  test("authorization_token values are redacted and the field is never carried", () => {
    const err = Object.assign(new Error("auth authorization_token=ghp_leak failed"), {
      authorization_token: "ghp_should_never_appear",
      endpoint: "https://api.example?authorization_token=ghp_in_url",
      status: 401,
    });
    const summary = extractSdkCause(err);
    expect(summary).not.toHaveProperty("authorization_token");
    expect(JSON.stringify(summary)).not.toContain("ghp_should_never_appear");
    expect(summary?.endpoint).toContain("authorization_token=[redacted]");
    expect(summary?.endpoint).not.toContain("ghp_in_url");
    expect(summary?.message).toContain("authorization_token=[redacted]");
    expect(summary?.message).not.toContain("ghp_leak");
  });

  test("token-bearing query params and bare PATs are scrubbed without exact URL match", () => {
    const err = Object.assign(new Error("failed for ghp_barepat123 Bearer sk_live_abc"), {
      endpoint: "https://mcp.example/github?token=ghp_querypat&other=1",
      status: 400,
    });
    const summary = extractSdkCause(err);
    expect(summary?.endpoint).toContain("token=[redacted]");
    expect(summary?.endpoint).not.toContain("ghp_querypat");
    expect(summary?.message).toContain("[token]");
    expect(summary?.message).toContain("Bearer [token]");
    expect(summary?.message).not.toContain("ghp_barepat123");
    expect(summary?.message).not.toContain("sk_live_abc");
  });

  test("URL-encoded authorization_token embeddings are redacted", () => {
    const err = Object.assign(new Error("bad"), {
      endpoint: "https://api.example?authorization_token%3Dghp_encoded",
      status: 401,
    });
    const summary = extractSdkCause(err);
    expect(summary?.endpoint).toContain("authorization_token%3D[redacted]");
    expect(summary?.endpoint).not.toContain("ghp_encoded");
  });

  test("percent-encoded token= query values are redacted", () => {
    const err = Object.assign(new Error("echo"), {
      endpoint: "https://mcp.example/github?token%3Dghp_encodedpat&x=1",
      status: 400,
    });
    const summary = extractSdkCause(err);
    expect(summary?.endpoint).toContain("token%3D[redacted]");
    expect(summary?.endpoint).not.toContain("ghp_encodedpat");
  });

  test("double-encoded token%253D query values do not leak the PAT", () => {
    const err = Object.assign(new Error("echo"), {
      endpoint: "https://mcp.example/github?token%253Dghp_doubleenc&x=1",
      status: 400,
    });
    const summary = extractSdkCause(err);
    expect(summary?.endpoint).not.toContain("ghp_doubleenc");
    expect(summary?.endpoint).toContain("[token]");
  });

  test("detail / message truncated at the cap", () => {
    const long = "y".repeat(500);
    const summary = extractSdkCause(new Error(long), { maxChars: 200 });
    expect(summary?.message?.length).toBe(200);
    expect(summary?.message?.endsWith("...")).toBe(true);
  });

  test("walks one .cause level when the wrapper has no fields", () => {
    const inner = Object.assign(new Error("inner"), { status: 400, code: "bad" });
    const outer = new Error("wrapper", { cause: inner });
    expect(extractSdkCause(outer)).toMatchObject({ status: 400, code: "bad", message: "inner" });
  });
});

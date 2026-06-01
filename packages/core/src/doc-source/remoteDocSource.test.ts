/** Direct tests for the octokit-backed DocSource (fetch + resolveRef). */

import { RequestError } from "@octokit/request-error";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RemoteDocFetchError } from "../errors.js";
import { createRemoteDocSource } from "./remoteDocSource.js";

// Shared mock Octokit instance; `new Octokit()` in the module under test
// returns this so each test scripts its rest methods.
const { mockOctokit } = vi.hoisted(() => ({
  mockOctokit: {
    rest: {
      repos: { getContent: vi.fn(), get: vi.fn() },
      pulls: { get: vi.fn() },
    },
  },
}));

vi.mock("@octokit/rest", () => ({ Octokit: vi.fn(() => mockOctokit) }));

function requestError(status: number): RequestError {
  return new RequestError("boom", status, {
    request: { method: "GET", url: "https://api.github.com/x", headers: {} },
  });
}

beforeEach(() => {
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
  mockOctokit.rest.repos.getContent.mockReset();
  mockOctokit.rest.repos.get.mockReset();
  mockOctokit.rest.pulls.get.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fetch", () => {
  test("decodes a base64 file blob", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from("hi there").toString("base64"),
      },
    });
    const src = createRemoteDocSource("tok");
    await expect(src.fetch({ owner: "o", repo: "r", path: "a.md", ref: "main" })).resolves.toBe(
      "hi there",
    );
  });

  test("returns non-base64 content verbatim", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: { type: "file", encoding: "utf-8", content: "plain text" },
    });
    const src = createRemoteDocSource("tok");
    await expect(src.fetch({ owner: "o", repo: "r", path: "a.md", ref: "main" })).resolves.toBe(
      "plain text",
    );
  });

  test("rejects a directory / non-file path", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({ data: [{ type: "dir" }] });
    const src = createRemoteDocSource("tok");
    await expect(
      src.fetch({ owner: "o", repo: "r", path: "dir", ref: "main" }),
    ).rejects.toBeInstanceOf(RemoteDocFetchError);
  });

  test("rejects empty file content", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: { type: "file", encoding: "base64", content: "" },
    });
    const src = createRemoteDocSource("tok");
    await expect(
      src.fetch({ owner: "o", repo: "r", path: "a.md", ref: "main" }),
    ).rejects.toBeInstanceOf(RemoteDocFetchError);
  });

  test("maps a 404 RequestError to RemoteDocFetchError and suggests a token when tokenless", async () => {
    mockOctokit.rest.repos.getContent.mockRejectedValue(requestError(404));
    const src = createRemoteDocSource(); // tokenless (env stubbed empty)
    await expect(src.fetch({ owner: "o", repo: "r", path: "a.md", ref: "main" })).rejects.toThrow(
      /GITHUB_TOKEN|GH_TOKEN/,
    );
  });

  test("maps a generic (non-RequestError) failure to RemoteDocFetchError", async () => {
    mockOctokit.rest.repos.getContent.mockRejectedValue(new Error("network down"));
    const src = createRemoteDocSource("tok");
    await expect(
      src.fetch({ owner: "o", repo: "r", path: "a.md", ref: "main" }),
    ).rejects.toBeInstanceOf(RemoteDocFetchError);
  });
});

describe("resolveRef", () => {
  test("returns startingRef without any network call", async () => {
    const src = createRemoteDocSource("tok");
    await expect(src.resolveRef({ owner: "o", repo: "r", startingRef: "feat/x" })).resolves.toBe(
      "feat/x",
    );
    expect(mockOctokit.rest.repos.get).not.toHaveBeenCalled();
  });

  test("resolves a PR head ref from prUrl", async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: { head: { ref: "pr-branch", repo: { full_name: "o/r" } } },
    });
    const src = createRemoteDocSource("tok");
    await expect(
      src.resolveRef({ owner: "o", repo: "r", prUrl: "https://github.com/o/r/pull/7" }),
    ).resolves.toBe("pr-branch");
  });

  test("rejects when the prUrl repo does not match the configured repo", async () => {
    const src = createRemoteDocSource("tok");
    await expect(
      src.resolveRef({ owner: "o", repo: "r", prUrl: "https://github.com/other/repo/pull/7" }),
    ).rejects.toBeInstanceOf(RemoteDocFetchError);
    expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  test("accepts a prUrl whose repo slug differs only in case", async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: { head: { ref: "feat", repo: { full_name: "O/R" } } },
    });
    const src = createRemoteDocSource("tok");
    await expect(
      src.resolveRef({ owner: "o", repo: "r", prUrl: "https://github.com/O/R/pull/7" }),
    ).resolves.toBe("feat");
  });

  test("rejects fork PR head ref (cross-fork fetch unsupported)", async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: { head: { ref: "fork-branch", repo: { full_name: "forker/r" } } },
    });
    const src = createRemoteDocSource("tok");
    const err = await src
      .resolveRef({ owner: "o", repo: "r", prUrl: "https://github.com/o/r/pull/7" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteDocFetchError);
    expect((err as Error).message).toMatch(/cross-fork|single-repo/i);
  });

  test("rejects PR head with missing repo (deleted fork)", async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: { head: { ref: "gone", repo: null } },
    });
    const src = createRemoteDocSource("tok");
    const err = await src
      .resolveRef({ owner: "o", repo: "r", prUrl: "https://github.com/o/r/pull/7" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteDocFetchError);
    expect((err as Error).message).toMatch(/unavailable|deleted/i);
  });

  test("falls back to the default branch and caches it", async () => {
    mockOctokit.rest.repos.get.mockResolvedValue({ data: { default_branch: "trunk" } });
    const src = createRemoteDocSource("tok");
    await expect(src.resolveRef({ owner: "o", repo: "r" })).resolves.toBe("trunk");
    // Second call hits the per-run cache — no second repos.get.
    await expect(src.resolveRef({ owner: "o", repo: "r" })).resolves.toBe("trunk");
    expect(mockOctokit.rest.repos.get).toHaveBeenCalledTimes(1);
  });

  test("maps a default-branch lookup failure to RemoteDocFetchError", async () => {
    mockOctokit.rest.repos.get.mockRejectedValue(requestError(403));
    const src = createRemoteDocSource("tok");
    await expect(src.resolveRef({ owner: "o", repo: "r" })).rejects.toBeInstanceOf(
      RemoteDocFetchError,
    );
  });
});

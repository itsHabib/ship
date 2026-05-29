/** Tests for GitHub URL parsing helpers. */

import { describe, expect, test } from "vitest";

import {
  parseGitHubOwnerRepo,
  parseGitHubPullNumber,
  parseGitHubRepoSlug,
  splitRepoSlug,
} from "./parse-github-url.js";

describe("parseGitHubRepoSlug", () => {
  test.each([
    ["https://github.com/acme/sandbox", "acme/sandbox"],
    ["https://github.com/acme/sandbox.git", "acme/sandbox"],
    ["https://github.com/acme/sandbox/", "acme/sandbox"],
    ["git@github.com:acme/sandbox.git", "acme/sandbox"],
    ["git@github.com:acme/sandbox", "acme/sandbox"],
  ])("parses %s → %s", (url, expected) => {
    expect(parseGitHubRepoSlug(url)).toBe(expected);
  });

  test("returns undefined for unparseable URLs", () => {
    expect(parseGitHubRepoSlug("not-a-url")).toBeUndefined();
    expect(parseGitHubRepoSlug("https://gitlab.com/o/r")).toBeUndefined();
  });
});

describe("parseGitHubOwnerRepo", () => {
  test("throws for non-GitHub hosts", () => {
    expect(() => parseGitHubOwnerRepo("https://gitlab.com/o/r")).toThrow(/github\.com/);
  });
});

describe("splitRepoSlug", () => {
  test("splits owner/repo", () => {
    expect(splitRepoSlug("acme/sandbox")).toEqual({ owner: "acme", repo: "sandbox" });
  });
});

describe("parseGitHubPullNumber", () => {
  test("extracts pull number", () => {
    expect(parseGitHubPullNumber("https://github.com/acme/sandbox/pull/42")).toBe(42);
  });
});

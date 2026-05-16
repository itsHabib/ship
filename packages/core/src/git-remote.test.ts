// Unit tests for the pure helpers exported from git-remote.ts. The
// shell-out wrappers themselves are exercised by the integration
// suite (real git binary against a tmp repo); here we cover the
// text/URL parsing that's prone to drift.

import { describe, expect, test } from "vitest";

import { parseHeadBranchFromRemoteShow } from "./git-remote.js";
// `parseOriginRepoFromUrl` is exported only from git-remote.ts; importing
// directly keeps the test scoped to the parsing surface.
import { parseOriginRepoFromUrl } from "./git-remote.js";

describe("parseHeadBranchFromRemoteShow", () => {
  test("extracts HEAD branch from typical `git remote show origin` output", () => {
    const stdout = [
      "* remote origin",
      "  Fetch URL: https://github.com/x/y",
      "  Push URL: https://github.com/x/y",
      "  HEAD branch: main",
      "  Remote branches:",
      "    main tracked",
    ].join("\n");
    expect(parseHeadBranchFromRemoteShow(stdout)).toBe("main");
  });

  test("returns null when HEAD branch is the literal (unknown)", () => {
    expect(parseHeadBranchFromRemoteShow("  HEAD branch: (unknown)\n")).toBeNull();
  });

  test("returns null when no HEAD branch line is present", () => {
    expect(parseHeadBranchFromRemoteShow("nothing useful here\n")).toBeNull();
  });

  test("handles CRLF line endings (Windows git output)", () => {
    expect(parseHeadBranchFromRemoteShow("  HEAD branch: develop\r\n")).toBe("develop");
  });
});

describe("parseOriginRepoFromUrl", () => {
  test("parses https://github.com form (with .git suffix)", () => {
    expect(parseOriginRepoFromUrl("https://github.com/itsHabib/ship.git")).toEqual({
      owner: "itsHabib",
      repo: "ship",
    });
  });

  test("parses https://github.com form (without .git suffix)", () => {
    expect(parseOriginRepoFromUrl("https://github.com/itsHabib/ship")).toEqual({
      owner: "itsHabib",
      repo: "ship",
    });
  });

  test("parses SSH (git@) form", () => {
    expect(parseOriginRepoFromUrl("git@github.com:itsHabib/ship.git")).toEqual({
      owner: "itsHabib",
      repo: "ship",
    });
  });

  test("parses http:// (insecure) form", () => {
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- exercising the parser's http scheme branch
    expect(parseOriginRepoFromUrl("http://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("returns null on empty URL", () => {
    expect(parseOriginRepoFromUrl("")).toBeNull();
  });

  test("returns null on truncated SSH form (no colon)", () => {
    expect(parseOriginRepoFromUrl("git@github.com/owner/repo")).toBeNull();
  });

  test("returns null when the tail has nested slashes after the repo segment", () => {
    expect(parseOriginRepoFromUrl("https://github.com/owner/repo/extra")).toBeNull();
  });

  test("returns null when host is set but owner/repo is missing", () => {
    expect(parseOriginRepoFromUrl("https://github.com/justowner")).toBeNull();
  });

  test("returns null on unrecognized scheme", () => {
    expect(parseOriginRepoFromUrl("ftp://example.com/owner/repo")).toBeNull();
  });
});

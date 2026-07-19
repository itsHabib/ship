/** Tests for `dispatch-cell.ts` — the shared cell matrix + preconditions. */

import { describe, expect, it } from "vitest";

import { cellStructuralIssue, isLegalCell, missingCredentialEnv } from "./dispatch-cell.js";

describe("isLegalCell", () => {
  it("accepts wired cells", () => {
    expect(isLegalCell("cursor", "cloud")).toBe(true);
    expect(isLegalCell("cursor", "rooms")).toBe(true);
    expect(isLegalCell("claude", "cloud")).toBe(true);
    expect(isLegalCell("claude", "local")).toBe(true);
    expect(isLegalCell("codex", "local")).toBe(true);
  });

  it("rejects unwired cells", () => {
    expect(isLegalCell("codex", "cloud")).toBe(false);
    expect(isLegalCell("codex", "rooms")).toBe(false);
    expect(isLegalCell("claude", "rooms")).toBe(false);
  });
});

describe("cellStructuralIssue", () => {
  const full = { branchName: "feat-a", repoUrl: "https://example.com/r" };

  it("returns undefined for a satisfied cell", () => {
    expect(cellStructuralIssue({ provider: "cursor", runtime: "cloud" }, full)).toBeUndefined();
    expect(cellStructuralIssue({ provider: "claude", runtime: "local" }, full)).toBeUndefined();
  });

  it("flags an unwired cell first", () => {
    expect(cellStructuralIssue({ provider: "codex", runtime: "cloud" }, full)).toBe("unwired-cell");
  });

  it("flags a missing branch for (local, *) and (cloud, claude)", () => {
    const noBranch = { branchName: undefined, repoUrl: "https://example.com/r" };
    expect(cellStructuralIssue({ provider: "cursor", runtime: "local" }, noBranch)).toBe(
      "needs-branch",
    );
    expect(cellStructuralIssue({ provider: "claude", runtime: "cloud" }, noBranch)).toBe(
      "needs-branch",
    );
  });

  it("does not require a branch for (cloud, cursor)", () => {
    const noBranch = { branchName: undefined, repoUrl: "https://example.com/r" };
    expect(cellStructuralIssue({ provider: "cursor", runtime: "cloud" }, noBranch)).toBeUndefined();
  });

  it("flags a missing repo_url for any cloud cell", () => {
    const noRepo = { branchName: "feat-a", repoUrl: undefined };
    expect(cellStructuralIssue({ provider: "cursor", runtime: "cloud" }, noRepo)).toBe(
      "needs-repo-url",
    );
    expect(cellStructuralIssue({ provider: "claude", runtime: "cloud" }, noRepo)).toBe(
      "needs-repo-url",
    );
  });

  it("does not require repo_url for local cells", () => {
    const noRepo = { branchName: "feat-a", repoUrl: undefined };
    expect(cellStructuralIssue({ provider: "codex", runtime: "local" }, noRepo)).toBeUndefined();
  });
});

describe("missingCredentialEnv", () => {
  it("checks CURSOR_API_KEY for cursor", () => {
    expect(missingCredentialEnv({ provider: "cursor", runtime: "cloud" }, {})).toBe(
      "CURSOR_API_KEY",
    );
    expect(
      missingCredentialEnv({ provider: "cursor", runtime: "cloud" }, { CURSOR_API_KEY: "k" }),
    ).toBeUndefined();
  });

  it("accepts any claude/local token, only API_KEY for claude/cloud", () => {
    expect(
      missingCredentialEnv(
        { provider: "claude", runtime: "local" },
        { CLAUDE_CODE_OAUTH_TOKEN: "o" },
      ),
    ).toBeUndefined();
    expect(
      missingCredentialEnv({ provider: "claude", runtime: "local" }, { ANTHROPIC_AUTH_TOKEN: "t" }),
    ).toBeUndefined();
    expect(
      missingCredentialEnv({ provider: "claude", runtime: "local" }, { ANTHROPIC_API_KEY: "k" }),
    ).toBeUndefined();
    expect(missingCredentialEnv({ provider: "claude", runtime: "local" }, {})).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY",
    );
    // AUTH_TOKEN alone does not satisfy the cloud runner (spec §4.4).
    expect(
      missingCredentialEnv({ provider: "claude", runtime: "cloud" }, { ANTHROPIC_AUTH_TOKEN: "t" }),
    ).toBe("ANTHROPIC_API_KEY");
    expect(
      missingCredentialEnv({ provider: "claude", runtime: "cloud" }, { ANTHROPIC_API_KEY: "k" }),
    ).toBeUndefined();
  });

  it("accepts either key for codex", () => {
    expect(
      missingCredentialEnv({ provider: "codex", runtime: "local" }, { CODEX_API_KEY: "k" }),
    ).toBeUndefined();
    expect(
      missingCredentialEnv({ provider: "codex", runtime: "local" }, { OPENAI_API_KEY: "k" }),
    ).toBeUndefined();
    expect(missingCredentialEnv({ provider: "codex", runtime: "local" }, {})).toBe(
      "CODEX_API_KEY or OPENAI_API_KEY",
    );
  });

  it("treats a whitespace-only value as absent", () => {
    expect(
      missingCredentialEnv({ provider: "cursor", runtime: "cloud" }, { CURSOR_API_KEY: "   " }),
    ).toBe("CURSOR_API_KEY");
  });
});

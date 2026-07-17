/** Tests for the dispatch-time `.ship.json` credential-source guard. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveDispatchCredential } from "./credential-source.js";
import { CredentialSourcePolicyError } from "./errors.js";

describe("resolveDispatchCredential", () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ship-cred-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  function writePolicy(content: string): void {
    writeFileSync(join(repoRoot, ".ship.json"), content, "utf8");
  }

  // Wraps the guard so throw-assertions don't trip no-confusing-void-expression;
  // the resolved value is discarded (throw-path tests only).
  function attempt(cwd: string, env: NodeJS.ProcessEnv): () => void {
    return () => {
      resolveDispatchCredential(cwd, env);
    };
  }

  it("is a no-op when no .ship.json exists (byte-identical to today)", () => {
    expect(attempt(repoRoot, {})).not.toThrow();
  });

  it("is a no-op when .ship.json has no credentials block", () => {
    writePolicy(JSON.stringify({ runtime: { allow: ["local"] } }));
    expect(attempt(repoRoot, {})).not.toThrow();
  });

  it("refuses when the pinned token env is absent, naming the source", () => {
    writePolicy(JSON.stringify({ credentials: { claude_token_env: "WORK_ANTHROPIC_TOKEN" } }));
    expect(attempt(repoRoot, {})).toThrow(CredentialSourcePolicyError);
    expect(attempt(repoRoot, {})).toThrow(/WORK_ANTHROPIC_TOKEN/);
  });

  it("refuses when the pinned token env is empty/whitespace", () => {
    writePolicy(JSON.stringify({ credentials: { claude_token_env: "WORK_ANTHROPIC_TOKEN" } }));
    expect(attempt(repoRoot, { WORK_ANTHROPIC_TOKEN: "   " })).toThrow(/absent or empty/);
  });

  it("passes when the pinned token env is present", () => {
    writePolicy(JSON.stringify({ credentials: { claude_token_env: "WORK_ANTHROPIC_TOKEN" } }));
    expect(attempt(repoRoot, { WORK_ANTHROPIC_TOKEN: "sk-work-123" })).not.toThrow();
  });

  it("refuses when a forbidden env override is present, naming it", () => {
    writePolicy(JSON.stringify({ credentials: { forbid_env: ["ANTHROPIC_BASE_URL"] } }));
    expect(attempt(repoRoot, { ANTHROPIC_BASE_URL: "https://personal.example" })).toThrow(
      /ANTHROPIC_BASE_URL/,
    );
  });

  it("passes when a forbidden env is unset or empty", () => {
    writePolicy(JSON.stringify({ credentials: { forbid_env: ["ANTHROPIC_BASE_URL"] } }));
    expect(attempt(repoRoot, {})).not.toThrow();
    expect(attempt(repoRoot, { ANTHROPIC_BASE_URL: "" })).not.toThrow();
  });

  it("ignores gh_host_user (a gh-write concern, not a dispatch-env concern)", () => {
    writePolicy(JSON.stringify({ credentials: { gh_host_user: "work-login" } }));
    expect(attempt(repoRoot, {})).not.toThrow();
  });

  it("discovers .ship.json walking up from a nested cwd", () => {
    writePolicy(JSON.stringify({ credentials: { claude_token_env: "WORK_ANTHROPIC_TOKEN" } }));
    expect(attempt(join(repoRoot, "docs"), {})).toThrow(/WORK_ANTHROPIC_TOKEN/);
  });

  it("fails closed on malformed JSON", () => {
    writePolicy("{ not json");
    expect(attempt(repoRoot, {})).toThrow(CredentialSourcePolicyError);
    expect(attempt(repoRoot, {})).toThrow(/malformed JSON/);
  });

  it("fails closed when credentials is not an object", () => {
    writePolicy(JSON.stringify({ credentials: ["WORK_ANTHROPIC_TOKEN"] }));
    expect(attempt(repoRoot, {})).toThrow(/credentials must be an object/);
  });

  it("fails closed when forbid_env is not an array", () => {
    writePolicy(JSON.stringify({ credentials: { forbid_env: "ANTHROPIC_BASE_URL" } }));
    expect(attempt(repoRoot, {})).toThrow(/forbid_env must be an array/);
  });

  it("fails closed when a forbid_env entry is not a non-empty string", () => {
    writePolicy(JSON.stringify({ credentials: { forbid_env: ["OK", 3] } }));
    expect(attempt(repoRoot, {})).toThrow(/forbid_env\[1\] must be a non-empty string/);
  });

  it("fails closed when claude_token_env is present but empty", () => {
    writePolicy(JSON.stringify({ credentials: { claude_token_env: "  " } }));
    expect(attempt(repoRoot, {})).toThrow(/claude_token_env must be a non-empty string/);
  });

  it("stops at the repo root and does not read a policy above .git", () => {
    // A policy above the repo root must not be discovered — the walk stops at .git.
    writeFileSync(
      join(tmpDir, ".ship.json"),
      JSON.stringify({ credentials: { claude_token_env: "WORK_ANTHROPIC_TOKEN" } }),
    );
    expect(attempt(repoRoot, {})).not.toThrow();
  });

  it("passes the env through unchanged when nothing is pinned", () => {
    const env = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-personal" };
    const resolved = resolveDispatchCredential(repoRoot, env);
    expect(resolved.token).toBeUndefined();
    expect(resolved.env["ANTHROPIC_API_KEY"]).toBe("sk-personal");
  });

  it("routes a pinned custom token into ANTHROPIC_AUTH_TOKEN and strips competing creds", () => {
    writePolicy(JSON.stringify({ credentials: { claude_token_env: "WORK_ANTHROPIC_TOKEN" } }));
    const resolved = resolveDispatchCredential(repoRoot, {
      WORK_ANTHROPIC_TOKEN: "sk-work-123",
      ANTHROPIC_API_KEY: "sk-personal",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-personal",
      PATH: "/bin",
    });
    // The pinned token is the ONLY credential a recognized reader can see.
    expect(resolved.token).toBe("sk-work-123");
    expect(resolved.env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-work-123");
    expect(resolved.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(resolved.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(resolved.env["PATH"]).toBe("/bin"); // non-credential vars pass through
  });

  it("trims a pinned token env name so the lookup is not thrown off by whitespace", () => {
    writePolicy(JSON.stringify({ credentials: { claude_token_env: "  WORK_ANTHROPIC_TOKEN  " } }));
    const resolved = resolveDispatchCredential(repoRoot, { WORK_ANTHROPIC_TOKEN: "sk-work-123" });
    expect(resolved.token).toBe("sk-work-123");
    expect(resolved.env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-work-123");
  });
});

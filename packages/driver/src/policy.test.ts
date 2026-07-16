/** Tests for `loadDispatchPolicy` discovery, validation, and resolution. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DispatchPolicyError,
  loadDispatchPolicy,
  providerCeilingViolation,
  resolveDispatchProvider,
  resolveDispatchRuntime,
  runtimeCeilingViolation,
} from "./policy.js";

describe("loadDispatchPolicy discovery", () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ship-policy-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, "docs", "tasks"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("finds a policy at the repo root walking up from a nested dir", () => {
    const policyPath = join(repoRoot, ".ship.json");
    writeFileSync(policyPath, JSON.stringify({ runtime: { allow: ["local"] } }), "utf8");

    const loaded = loadDispatchPolicy(join(repoRoot, "docs", "tasks"));
    expect(loaded.policyPath).toBe(policyPath);
    expect(loaded.policy.runtime?.allow).toEqual(["local"]);
  });

  it("takes the first policy found mid-path, not the repo-root one", () => {
    writeFileSync(join(repoRoot, ".ship.json"), JSON.stringify({ runtime: { allow: ["cloud"] } }));
    const midPath = join(repoRoot, "docs", ".ship.json");
    writeFileSync(midPath, JSON.stringify({ runtime: { allow: ["local"] } }), "utf8");

    const loaded = loadDispatchPolicy(join(repoRoot, "docs", "tasks"));
    expect(loaded.policyPath).toBe(midPath);
    expect(loaded.policy.runtime?.allow).toEqual(["local"]);
  });

  it("returns empty constraints when no policy file exists", () => {
    const loaded = loadDispatchPolicy(join(repoRoot, "docs", "tasks"));
    expect(loaded.policyPath).toBeUndefined();
    expect(loaded.policy).toEqual({});
    expect(loaded.warnings).toEqual([]);
  });

  it("stops at the repo root and does not read a policy above .git", () => {
    // A policy above the repo root must not be discovered — the walk stops at .git.
    writeFileSync(join(tmpDir, ".ship.json"), JSON.stringify({ runtime: { allow: ["cloud"] } }));
    const loaded = loadDispatchPolicy(join(repoRoot, "docs", "tasks"));
    expect(loaded.policyPath).toBeUndefined();
  });
});

describe("loadDispatchPolicy validation", () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ship-policy-val-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  function writePolicy(content: string): string {
    const policyPath = join(repoRoot, ".ship.json");
    writeFileSync(policyPath, content, "utf8");
    return policyPath;
  }

  it("throws a hard error naming the path on malformed JSON", () => {
    const policyPath = writePolicy("{ not json");
    expect(() => loadDispatchPolicy(repoRoot)).toThrow(DispatchPolicyError);
    expect(() => loadDispatchPolicy(repoRoot)).toThrow(policyPath);
  });

  it("throws on a runtime value outside the enum", () => {
    writePolicy(JSON.stringify({ runtime: { allow: ["local", "banana"] } }));
    expect(() => loadDispatchPolicy(repoRoot)).toThrow(/banana/);
  });

  it("throws on a provider default outside the enum", () => {
    writePolicy(JSON.stringify({ provider: { default: "gemini" } }));
    expect(() => loadDispatchPolicy(repoRoot)).toThrow(/gemini/);
  });

  it("throws when a default is outside its own allow", () => {
    writePolicy(JSON.stringify({ runtime: { default: "cloud", allow: ["local"] } }));
    expect(() => loadDispatchPolicy(repoRoot)).toThrow(/default 'cloud' is not in/);
  });

  it("warns on unknown top-level and nested keys without erroring", () => {
    writePolicy(
      JSON.stringify({
        runtime: { allow: ["local"], unknownNested: true },
        surprise: 1,
      }),
    );
    const loaded = loadDispatchPolicy(repoRoot);
    expect(loaded.policy.runtime?.allow).toEqual(["local"]);
    expect(loaded.warnings.some((w) => w.includes("surprise"))).toBe(true);
    expect(loaded.warnings.some((w) => w.includes("runtime.unknownNested"))).toBe(true);
  });

  it("throws when the top-level value is not an object", () => {
    writePolicy(JSON.stringify(["local"]));
    expect(() => loadDispatchPolicy(repoRoot)).toThrow(/must be a JSON object/);
  });

  it("throws when allow is not an array", () => {
    writePolicy(JSON.stringify({ runtime: { allow: "local" } }));
    expect(() => loadDispatchPolicy(repoRoot)).toThrow(/allow must be an array/);
  });
});

describe("policy resolution helpers", () => {
  const empty = { policy: {}, warnings: [] };

  it("applies default precedence: stream > manifest > policy > fallback", () => {
    const loaded = { policy: { runtime: { default: "cloud" as const } }, warnings: [] };
    expect(resolveDispatchRuntime(loaded, "rooms", "local")).toBe("rooms");
    expect(resolveDispatchRuntime(loaded, undefined, "local")).toBe("local");
    expect(resolveDispatchRuntime(loaded, undefined, undefined)).toBe("cloud");
    expect(resolveDispatchRuntime(empty, undefined, undefined)).toBe("local");
  });

  it("resolves provider default, leaving unset when no source supplies one", () => {
    const loaded = { policy: { provider: { default: "claude" as const } }, warnings: [] };
    expect(resolveDispatchProvider(loaded, "codex", undefined)).toBe("codex");
    expect(resolveDispatchProvider(loaded, undefined, undefined)).toBe("claude");
    expect(resolveDispatchProvider(empty, undefined, undefined)).toBeUndefined();
  });

  it("flags a runtime outside the allow ceiling", () => {
    const loaded = { policy: { runtime: { allow: ["local" as const] } }, warnings: [] };
    expect(runtimeCeilingViolation(loaded, "cloud")).toMatch(/runtime 'cloud' is not permitted/);
    expect(runtimeCeilingViolation(loaded, "local")).toBeUndefined();
    expect(runtimeCeilingViolation(empty, "cloud")).toBeUndefined();
  });

  it("checks an unset provider against the cursor dispatch fallback", () => {
    const loaded = { policy: { provider: { allow: ["claude" as const] } }, warnings: [] };
    // undefined provider dispatches as cursor — must be rejected by a claude-only allow.
    expect(providerCeilingViolation(loaded, undefined)).toMatch(/provider 'cursor'/);
    expect(providerCeilingViolation(loaded, "claude")).toBeUndefined();
  });
});

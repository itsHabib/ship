/**
 * Unit + property tests for dispatch-fallback hop policy (P2a).
 */

import type { DriverStream, FallbackChainTarget } from "@ship/store";
import type { FailureCategory } from "@ship/workflow";

import { fc, test as fcTest } from "@fast-check/vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { ViabilityDeps } from "./viability.js";

import {
  buildFallbackExhaustionEscalationCopy,
  decideFallbackHop,
  FALLBACK_ELIGIBLE_CATEGORIES,
  hasExhaustedFallbackChain,
  hasNoWorkProducts,
  hasUnconsumedFallbackChain,
  isFallbackEligibleCategory,
} from "./fallback-hop.js";

function baseStream(overrides: Partial<DriverStream> = {}): DriverStream {
  return {
    attempts: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    driverBatchId: "bat_1",
    driverRunId: "run_1",
    id: "str_1",
    runtime: "cloud",
    specPath: "docs/tasks/a.md",
    status: "failed",
    streamIndex: 0,
    touches: [],
    updatedAt: "2026-07-13T00:00:00.000Z",
    reviewCycles: 0,
    fallbackChain: [{ provider: "claude", runtime: "local" }],
    fallbackCursor: 0,
    fallbackLog: [],
    branch: "feat-a",
    provider: "cursor",
    ...overrides,
  };
}

function viability(env: Record<string, string | undefined> = {}): ViabilityDeps {
  return {
    env: {
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
      CURSOR_API_KEY: "c",
      ...env,
    },
    listCursorModels: () => Promise.resolve(["m"]),
  };
}

describe("fallback eligibility (§4.2)", () => {
  test.each([
    ["sdk-throw", true],
    ["gateway-unreachable", true],
    ["gateway-auth", true],
    ["budget-exceeded", false],
    ["contention", false],
    ["logic", false],
    ["unknown", false],
    ["timeout-near-cap", false],
  ] as const)("%s → eligible=%s", (category, eligible) => {
    expect(isFallbackEligibleCategory(category)).toBe(eligible);
  });

  test("allowlist is exactly the three pre-work environmental categories", () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...FALLBACK_ELIGIBLE_CATEGORIES].sort(byName)).toEqual(
      ["gateway-auth", "gateway-unreachable", "sdk-throw"].sort(byName),
    );
  });
});

describe("no-work-products gate (§4.3)", () => {
  test("fresh pre-work stream is hoppable", () => {
    expect(hasNoWorkProducts(baseStream({ reviewCycles: 0 }))).toBe(true);
  });

  test("unset reviewCycles coalesces to 0 (still hoppable without prUrl)", () => {
    const stream = baseStream();
    delete (stream as { reviewCycles?: number }).reviewCycles;
    expect(hasNoWorkProducts(stream)).toBe(true);
  });

  test("reviewCycles > 0 blocks hop", () => {
    expect(hasNoWorkProducts(baseStream({ reviewCycles: 1 }))).toBe(false);
  });

  test("prUrl at reviewCycles 0 blocks hop (failed-flip / cloud-autoPR)", () => {
    expect(
      hasNoWorkProducts(
        baseStream({ prUrl: "https://github.com/example/ship/pull/1", reviewCycles: 0 }),
      ),
    ).toBe(false);
  });

  test("poll-seam PR URL blocks hop before stream column is written", () => {
    expect(
      hasNoWorkProducts(baseStream({ reviewCycles: 0 }), "https://github.com/x/y/pull/2"),
    ).toBe(false);
  });
});

describe("FALLBACK_RESET_PATCH via decideFallbackHop", () => {
  let repoRoot: string;

  afterEach(() => {
    rmSync(repoRoot, { force: true, recursive: true });
  });

  test("hop rewrites runtime/provider, clears pending columns, advances cursor, resets workOnCurrentBranch", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "fallback-hop-"));
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });

    const stream = baseStream({
      dispatchModel: "old",
      dispatchProvider: "cursor",
      effortDegraded: true,
      tierDegradeReason: "x",
      workOnCurrentBranch: true,
    });
    const failedAttempts = [
      {
        dispatchedAt: "2026-07-13T00:00:00.000Z",
        docPath: "/doc",
        failureCategory: "sdk-throw" as const,
        terminal: true,
      },
    ];

    const decision = await decideFallbackHop(stream, {
      at: "2026-07-13T00:01:00.000Z",
      category: "sdk-throw",
      failedAttempts,
      repoRoot,
      repoUrl: "https://github.com/example/ship",
      viability: viability(),
    });

    expect(decision.kind).toBe("hop");
    if (decision.kind !== "hop") return;
    expect(decision.patch).toMatchObject({
      dispatchModel: null,
      dispatchModelParams: null,
      dispatchProvider: null,
      effortDegraded: false,
      fallbackCursor: 1,
      provider: "claude",
      runtime: "local",
      status: "pending",
      tierDegradeReason: null,
      workOnCurrentBranch: false,
    });
    expect(decision.patch.attempts?.[0]?.resetBoundary).toBe(true);
    expect(decision.patch.fallbackLog).toEqual([
      {
        from: { provider: "cursor", runtime: "cloud" },
        to: { provider: "claude", runtime: "local" },
        category: "sdk-throw",
        at: "2026-07-13T00:01:00.000Z",
      },
    ]);
  });

  test("missing local worktree is skipped with a recorded reason", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "fallback-hop-missing-wt-"));

    const decision = await decideFallbackHop(baseStream(), {
      at: "2026-07-13T00:01:00.000Z",
      category: "gateway-auth",
      failedAttempts: [
        {
          dispatchedAt: "2026-07-13T00:00:00.000Z",
          docPath: "/doc",
          failureCategory: "gateway-auth",
          terminal: true,
        },
      ],
      repoRoot,
      repoUrl: "https://github.com/example/ship",
      viability: viability(),
    });

    expect(decision.kind).toBe("exhaust");
    if (decision.kind !== "exhaust") return;
    expect(decision.patch.fallbackCursor).toBe(1);
    const skip = decision.patch.fallbackLog?.[0];
    expect(skip && "skipped" in skip).toBe(true);
    if (skip && "skipped" in skip) {
      expect(skip.reason).toMatch(/local worktree missing/);
    }
  });

  test("credential skip records reason then hops to next viable", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "fallback-hop-skip-"));
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });

    const stream = baseStream({
      fallbackChain: [
        { provider: "claude", runtime: "cloud" },
        { provider: "claude", runtime: "local" },
      ],
    });

    const decision = await decideFallbackHop(stream, {
      at: "2026-07-13T00:01:00.000Z",
      category: "sdk-throw",
      failedAttempts: [
        {
          dispatchedAt: "2026-07-13T00:00:00.000Z",
          docPath: "/doc",
          failureCategory: "sdk-throw",
          terminal: true,
        },
      ],
      repoRoot,
      repoUrl: "https://github.com/example/ship",
      viability: viability({ ANTHROPIC_API_KEY: undefined }),
    });

    expect(decision.kind).toBe("hop");
    if (decision.kind !== "hop") return;
    expect(decision.patch.runtime).toBe("local");
    expect(decision.patch.fallbackCursor).toBe(2);
    expect(decision.patch.fallbackLog).toHaveLength(2);
    const skip = decision.patch.fallbackLog?.[0];
    expect(skip && "skipped" in skip && skip.reason).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe("chain / breaker helpers", () => {
  test("unconsumed vs exhausted", () => {
    const live = baseStream({ fallbackCursor: 0 });
    expect(hasUnconsumedFallbackChain(live)).toBe(true);
    expect(hasExhaustedFallbackChain(live)).toBe(false);

    const done = baseStream({ fallbackCursor: 1 });
    expect(hasUnconsumedFallbackChain(done)).toBe(false);
    expect(hasExhaustedFallbackChain(done)).toBe(true);

    const empty = baseStream({
      fallbackChain: undefined,
      fallbackCursor: undefined,
      fallbackLog: undefined,
    });
    expect(hasUnconsumedFallbackChain(empty)).toBe(false);
    expect(hasExhaustedFallbackChain(empty)).toBe(false);
  });
});

describe("§6 exhaustion copy", () => {
  test("subject + derived failed line + bare-retry target", () => {
    const stream = baseStream({
      fallbackCursor: 1,
      fallbackLog: [
        {
          from: { provider: "cursor", runtime: "cloud" },
          to: { provider: "claude", runtime: "local" },
          category: "gateway-auth",
          at: "2026-07-13T00:01:00.000Z",
        },
      ],
      provider: "claude",
      runtime: "local",
      taskSlug: "feat-a",
    });
    const copy = buildFallbackExhaustionEscalationCopy(stream, "sdk-throw");
    expect(copy.subject).toBe("dispatch failed after fallback: feat-a exhausted 1-target chain");
    expect(copy.body).toContain("primary cloud/cursor: gateway-auth");
    expect(copy.body).toContain("hopped cloud/cursor → local/claude on gateway-auth");
    expect(copy.body).toContain("failed: sdk-throw on local/claude");
    expect(copy.body).toContain("bare decide retry re-fires local/claude");
  });

  test("credential skip includes remedy line", () => {
    const stream = baseStream({
      fallbackCursor: 1,
      fallbackLog: [
        {
          skipped: { provider: "claude", runtime: "local" },
          reason:
            "claude/local needs CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY in env",
          at: "2026-07-13T00:01:00.000Z",
        },
      ],
    });
    const copy = buildFallbackExhaustionEscalationCopy(stream, "gateway-auth");
    expect(copy.body).toMatch(/remedy: set /);
  });
});

describe("cursor monotonicity (property)", () => {
  fcTest.prop(
    [
      fc.array(
        fc.record({
          provider: fc.constantFrom("claude", "codex") as fc.Arbitrary<"claude" | "codex">,
          runtime: fc.constantFrom("local") as fc.Arbitrary<"local">,
        }),
        { minLength: 1, maxLength: 5 },
      ),
      fc.integer({ min: 0, max: 4 }),
    ],
    { numRuns: 40 },
  )("walk never decreases cursor and never reuses an index", async (chain, start) => {
    const repoRoot = mkdtempSync(join(tmpdir(), "fallback-mono-"));
    try {
      mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });
      const cursor = Math.min(start, chain.length);
      const stream = baseStream({
        fallbackChain: chain as FallbackChainTarget[],
        fallbackCursor: cursor,
      });
      const decision = await decideFallbackHop(stream, {
        at: "2026-07-13T00:01:00.000Z",
        category: "sdk-throw",
        failedAttempts: [
          {
            dispatchedAt: "2026-07-13T00:00:00.000Z",
            docPath: "/doc",
            failureCategory: "sdk-throw",
            terminal: true,
          },
        ],
        repoRoot,
        repoUrl: "https://github.com/example/ship",
        viability: viability({
          CODEX_API_KEY: "x",
        }),
      });
      if (decision.kind === "ineligible") return;
      const next = decision.patch.fallbackCursor ?? cursor;
      expect(next).toBeGreaterThan(cursor);
      expect(next).toBeLessThanOrEqual(chain.length);
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });
});

describe("ineligible categories short-circuit", () => {
  test("budget-exceeded does not walk", async () => {
    const decision = await decideFallbackHop(baseStream(), {
      at: "2026-07-13T00:01:00.000Z",
      category: "budget-exceeded" as FailureCategory,
      failedAttempts: [],
      repoRoot: "/tmp",
      repoUrl: "https://github.com/example/ship",
      viability: viability(),
    });
    expect(decision.kind).toBe("ineligible");
  });
});

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
  chainStillConsumable,
  decideFallbackHop,
  decideTransientRetry,
  FALLBACK_ELIGIBLE_CATEGORIES,
  hasCurrentTargetBeenRetried,
  hasExhaustedFallbackChain,
  hasNoWorkProducts,
  hasUnconsumedFallbackChain,
  hasUnusedTransientRetry,
  isFallbackEligibleCategory,
  isTransientBlipFailure,
  matchesTransientErrorShape,
  resolveDispatchModel,
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
      modelId: null,
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
        fromModel: "old",
        category: "sdk-throw",
        at: "2026-07-13T00:01:00.000Z",
      },
    ]);
  });

  test("hop writes the target's model_id; a stale primary id never rides along", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "fallback-hop-modelid-"));
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });
    const stream = baseStream({
      fallbackChain: [{ modelId: "target-model", provider: "claude", runtime: "local" }],
      modelId: "grok-4.5",
    });

    const decision = await decideFallbackHop(stream, {
      at: "2026-07-13T00:01:00.000Z",
      category: "sdk-throw",
      failedAttempts: [],
      repoRoot,
      repoUrl: "https://github.com/example/ship",
      viability: viability(),
    });

    expect(decision.kind).toBe("hop");
    if (decision.kind !== "hop") return;
    expect(decision.patch.modelId).toBe("target-model");
  });

  test("missing CURSOR_API_KEY is a definitive skip, never an UNKNOWN park", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "fallback-hop-nokey-"));
    const stream = baseStream({
      fallbackChain: [{ modelId: "m", provider: "cursor", runtime: "cloud" }],
      provider: "claude",
      runtime: "local",
    });

    const decision = await decideFallbackHop(stream, {
      at: "2026-07-13T00:01:00.000Z",
      category: "sdk-throw",
      failedAttempts: [],
      repoRoot,
      repoUrl: "https://github.com/example/ship",
      viability: {
        env: {},
        listCursorModels: () => Promise.reject(new Error("would not even be called")),
      },
    });

    expect(decision.kind).toBe("exhaust");
    if (decision.kind !== "exhaust") return;
    expect(decision.patch.fallbackLog).toMatchObject([{ reason: "CURSOR_API_KEY not set" }]);
  });

  test("viability throw (catalog outage) parks without consuming the chain", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "fallback-hop-outage-"));
    const stream = baseStream({
      fallbackChain: [{ modelId: "m", provider: "cursor", runtime: "cloud" }],
      provider: "claude",
      runtime: "local",
    });

    const decision = await decideFallbackHop(stream, {
      at: "2026-07-13T00:01:00.000Z",
      category: "sdk-throw",
      failedAttempts: [],
      repoRoot,
      repoUrl: "https://github.com/example/ship",
      viability: {
        env: { CURSOR_API_KEY: "c" },
        listCursorModels: () => Promise.reject(new Error("catalog timeout")),
      },
    });

    // UNKNOWN viability must not become a skip — the entry survives for a
    // later decide retry.
    expect(decision).toEqual({ kind: "ineligible" });
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
    // The ", or"-joined token list must survive whole — dropping the last env
    // var makes the remedy actively misleading.
    expect(copy.body).toContain(
      "remedy: set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY",
    );
  });
});

describe("chainStillConsumable (§7.2 step 0 breaker predicate)", () => {
  const failedAttempt = (category: FailureCategory) => ({
    dispatchedAt: "2026-07-13T00:00:00.000Z",
    docPath: "/doc",
    failureCategory: category,
    terminal: true,
  });

  test("eligible pre-work failure keeps the chain live", () => {
    const stream = baseStream({ attempts: [failedAttempt("sdk-throw")] });
    expect(chainStillConsumable(stream)).toBe(true);
  });

  test("ineligible category can never hop — chain must not suppress the breaker", () => {
    const stream = baseStream({ attempts: [failedAttempt("logic")] });
    expect(chainStillConsumable(stream)).toBe(false);
  });

  test("work-carrying stream (reviewCycles > 0) can never hop", () => {
    const stream = baseStream({ attempts: [failedAttempt("sdk-throw")], reviewCycles: 1 });
    expect(chainStillConsumable(stream)).toBe(false);
  });

  test("no attempts yet is benign (breaker only fires on failed streams)", () => {
    expect(chainStillConsumable(baseStream())).toBe(true);
  });

  test("unused transient retry on current target keeps the stream movement-capable", () => {
    const stream = baseStream({
      attempts: [failedAttempt("contention")],
      errorMessage: "local run contention — reduce parallelism",
    });
    expect(hasUnusedTransientRetry(stream)).toBe(true);
    expect(chainStillConsumable(stream)).toBe(true);
  });

  test("once retried and chain exhausted, chainStillConsumable is false", () => {
    const stream = baseStream({
      attempts: [failedAttempt("contention")],
      errorMessage: "local run contention — reduce parallelism",
      fallbackCursor: 1,
      fallbackLog: [
        {
          retried: { provider: "cursor", runtime: "cloud" },
          reason: "contention",
          at: "2026-07-13T00:01:00.000Z",
        },
      ],
    });
    expect(hasUnusedTransientRetry(stream)).toBe(false);
    expect(chainStillConsumable(stream)).toBe(false);
  });
});

describe("transient-blip retry (§4.7)", () => {
  test.each([
    ["connect ETIMEDOUT", true],
    ["read ECONNRESET", true],
    ["connect timeout from api.cursor.com", true],
    ["HTTP 429 rate_limit", true],
    ["rate limited by provider", true],
    ["fetch failed", true],
    ["boom — permanent auth reject", false],
    ["invalid_model", false],
  ] as const)("shape %j → transient=%s", (message, expected) => {
    expect(matchesTransientErrorShape(message)).toBe(expected);
    expect(isTransientBlipFailure(message, "sdk-throw")).toBe(expected);
  });

  test("contention category is transient even without a shape match", () => {
    expect(isTransientBlipFailure("local run contention — reduce parallelism", "contention")).toBe(
      true,
    );
    expect(isTransientBlipFailure("busy", "contention")).toBe(true);
  });

  test("chainless stream never retries — FR6 opt-in; fallbackLog cannot land on a row without the fallback columns", () => {
    const ctx = {
      at: "2026-07-13T00:01:00.000Z",
      category: "sdk-throw" as const,
      errorMessage: "connect ETIMEDOUT",
      failedAttempts: [],
    };
    const noChain = baseStream({
      fallbackChain: undefined,
      fallbackCursor: undefined,
      fallbackLog: undefined,
    });
    expect(decideTransientRetry(noChain, ctx)).toBeUndefined();
    expect(hasUnusedTransientRetry(noChain)).toBe(false);
    // Explicit [] opts out the same way (manifest `fallback: []`).
    const emptyChain = baseStream({ fallbackChain: [] });
    expect(decideTransientRetry(emptyChain, ctx)).toBeUndefined();
    expect(hasUnusedTransientRetry(emptyChain)).toBe(false);
  });

  test("pre-work transient failure records one same-target retry", () => {
    const stream = baseStream();
    const decision = decideTransientRetry(stream, {
      at: "2026-07-13T00:01:00.000Z",
      category: "sdk-throw",
      errorMessage: "connect ETIMEDOUT",
      failedAttempts: [
        {
          dispatchedAt: "2026-07-13T00:00:00.000Z",
          docPath: "/doc",
          failureCategory: "sdk-throw",
          terminal: true,
        },
      ],
    });
    expect(decision?.kind).toBe("retry");
    if (decision?.kind !== "retry") return;
    expect(decision.patch.status).toBe("pending");
    expect(decision.patch.fallbackLog).toEqual([
      {
        retried: { provider: "cursor", runtime: "cloud" },
        reason: "sdk-throw",
        at: "2026-07-13T00:01:00.000Z",
      },
    ]);
    expect(decision.patch.runtime).toBeUndefined();
    expect(decision.patch.provider).toBeUndefined();
  });

  test("one retry per target per lifecycle — second failure does not retry", () => {
    const stream = baseStream({
      fallbackLog: [
        {
          retried: { provider: "cursor", runtime: "cloud" },
          reason: "sdk-throw",
          at: "2026-07-13T00:00:30.000Z",
        },
      ],
    });
    expect(hasCurrentTargetBeenRetried(stream)).toBe(true);
    expect(
      decideTransientRetry(stream, {
        at: "2026-07-13T00:01:00.000Z",
        category: "sdk-throw",
        errorMessage: "connect ETIMEDOUT",
        failedAttempts: [],
      }),
    ).toBeUndefined();
  });

  test("decide-retry round-trip keeps the retried record (no second transparent retry)", () => {
    const afterRetry = baseStream({
      fallbackLog: [
        {
          retried: { provider: "cursor", runtime: "cloud" },
          reason: "sdk-throw",
          at: "2026-07-13T00:00:30.000Z",
        },
      ],
      status: "pending",
    });
    // Operator `decide retry` resets to pending but leaves fallbackLog intact.
    expect(
      decideTransientRetry(afterRetry, {
        at: "2026-07-13T00:02:00.000Z",
        category: "sdk-throw",
        errorMessage: "connect ETIMEDOUT",
        failedAttempts: [],
      }),
    ).toBeUndefined();
  });

  test("contention reaches retry before the category hop gate", () => {
    const stream = baseStream();
    const retry = decideTransientRetry(stream, {
      at: "2026-07-13T00:01:00.000Z",
      category: "contention",
      errorMessage: "local run contention — reduce parallelism",
      failedAttempts: [],
    });
    expect(retry?.kind).toBe("retry");
  });

  test("second contention escalates without consuming chain", async () => {
    const stream = baseStream({
      fallbackLog: [
        {
          retried: { provider: "cursor", runtime: "cloud" },
          reason: "contention",
          at: "2026-07-13T00:00:30.000Z",
        },
      ],
    });
    expect(
      decideTransientRetry(stream, {
        at: "2026-07-13T00:01:00.000Z",
        category: "contention",
        errorMessage: "local run contention — reduce parallelism",
        failedAttempts: [],
      }),
    ).toBeUndefined();
    const hop = await decideFallbackHop(stream, {
      at: "2026-07-13T00:01:00.000Z",
      category: "contention",
      failedAttempts: [],
      repoRoot: "/tmp",
      repoUrl: "https://github.com/example/ship",
      viability: viability(),
    });
    expect(hop.kind).toBe("ineligible");
    expect(stream.fallbackCursor).toBe(0);
  });

  test("non-transient failures skip straight to the hop gate", () => {
    expect(
      decideTransientRetry(baseStream(), {
        at: "2026-07-13T00:01:00.000Z",
        category: "sdk-throw",
        errorMessage: "boom",
        failedAttempts: [],
      }),
    ).toBeUndefined();
  });

  test("work-carrying stream does not get a transparent retry", () => {
    expect(
      decideTransientRetry(baseStream({ reviewCycles: 1 }), {
        at: "2026-07-13T00:01:00.000Z",
        category: "sdk-throw",
        errorMessage: "connect ETIMEDOUT",
        failedAttempts: [],
      }),
    ).toBeUndefined();
  });

  test("after a hop, the new target can still receive its own one retry", () => {
    const stream = baseStream({
      fallbackCursor: 1,
      fallbackLog: [
        {
          retried: { provider: "cursor", runtime: "cloud" },
          reason: "sdk-throw",
          at: "2026-07-13T00:00:30.000Z",
        },
        {
          from: { provider: "cursor", runtime: "cloud" },
          to: { provider: "claude", runtime: "local" },
          category: "sdk-throw",
          at: "2026-07-13T00:01:00.000Z",
        },
      ],
      provider: "claude",
      runtime: "local",
    });
    expect(hasCurrentTargetBeenRetried(stream)).toBe(false);
    const decision = decideTransientRetry(stream, {
      at: "2026-07-13T00:02:00.000Z",
      category: "sdk-throw",
      errorMessage: "ECONNRESET",
      failedAttempts: [],
    });
    expect(decision?.kind).toBe("retry");
    if (decision?.kind !== "retry") return;
    expect(decision.patch.fallbackLog?.at(-1)).toMatchObject({
      retried: { provider: "claude", runtime: "local" },
    });
  });
});

describe("hop-record model resolution (§4.1 residue)", () => {
  test("resolveDispatchModel: pinned model_id wins over tier", () => {
    expect(resolveDispatchModel("cursor", "opus", undefined, "grok-4.5")).toBe("grok-4.5");
    expect(resolveDispatchModel("cursor", "opus")).toBe("claude-opus-4-8");
    expect(resolveDispatchModel("claude", "opus")).toBe("claude-opus-4-8");
  });

  describe("hop records", () => {
    let repoRoot: string;

    afterEach(() => {
      rmSync(repoRoot, { force: true, recursive: true });
    });

    test("hop record carries resolved fromModel/toModel for tier-mapped sides", async () => {
      repoRoot = mkdtempSync(join(tmpdir(), "fallback-hop-models-"));
      mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });

      const stream = baseStream({
        dispatchModel: "claude-opus-4-8",
        modelTier: "opus",
      });
      const decision = await decideFallbackHop(stream, {
        at: "2026-07-13T00:01:00.000Z",
        category: "sdk-throw",
        failedAttempts: [],
        repoRoot,
        repoUrl: "https://github.com/example/ship",
        viability: viability(),
      });
      expect(decision.kind).toBe("hop");
      if (decision.kind !== "hop") return;
      expect(decision.patch.fallbackLog?.[0]).toMatchObject({
        fromModel: "claude-opus-4-8",
        toModel: "claude-opus-4-8",
        category: "sdk-throw",
      });
    });

    test("hop record resolves toModel from a pinned chain entry model_id", async () => {
      repoRoot = mkdtempSync(join(tmpdir(), "fallback-hop-pinned-"));
      mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });

      const stream = baseStream({
        dispatchModel: "composer-2.5",
        fallbackChain: [{ modelId: "claude-haiku-4-5", provider: "claude", runtime: "local" }],
        modelTier: "sonnet",
      });
      const decision = await decideFallbackHop(stream, {
        at: "2026-07-13T00:01:00.000Z",
        category: "sdk-throw",
        failedAttempts: [],
        repoRoot,
        repoUrl: "https://github.com/example/ship",
        viability: viability(),
      });
      expect(decision.kind).toBe("hop");
      if (decision.kind !== "hop") return;
      expect(decision.patch.fallbackLog?.[0]).toMatchObject({
        fromModel: "composer-2.5",
        toModel: "claude-haiku-4-5",
      });
      expect(decision.patch.modelId).toBe("claude-haiku-4-5");
    });
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

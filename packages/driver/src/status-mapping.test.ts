/** Tests for tier resolution helpers in status-mapping. */

import { describe, expect, it } from "vitest";

import {
  formatStreamFallbackDiagnostic,
  formatStreamTierDiagnostic,
  resolveStreamProvider,
  resolveStreamTier,
} from "./status-mapping.js";

describe("resolveStreamTier", () => {
  it("prefers stream fields over manifest defaults", () => {
    expect(
      resolveStreamTier(
        { spec_path: "a.md", model: "opus", effort: "max", touches: [] },
        "sonnet",
        "extra",
      ),
    ).toEqual({ modelTier: "opus", effortTier: "max" });
  });

  it("falls back to manifest defaults when stream omits tiers", () => {
    expect(resolveStreamTier({ spec_path: "a.md", touches: [] }, "fable", "extra")).toEqual({
      modelTier: "fable",
      effortTier: "extra",
    });
  });

  it("returns empty when no tiers are configured", () => {
    expect(resolveStreamTier({ spec_path: "a.md", touches: [] })).toEqual({});
  });

  it("resolves model_id from the stream field over the default", () => {
    expect(
      resolveStreamTier(
        { spec_path: "a.md", model_id: "grok-4.5", touches: [] },
        undefined,
        undefined,
        "composer-2.5",
      ),
    ).toEqual({ modelId: "grok-4.5" });
  });

  it("falls back to default_model_id when the stream omits model_id", () => {
    expect(
      resolveStreamTier({ spec_path: "a.md", touches: [] }, undefined, undefined, "grok-4.5"),
    ).toEqual({ modelId: "grok-4.5" });
  });

  it("carries model_id alongside the tier without either displacing the other", () => {
    expect(
      resolveStreamTier({ spec_path: "a.md", model: "opus", model_id: "grok-4.5", touches: [] }),
    ).toEqual({ modelTier: "opus", modelId: "grok-4.5" });
  });
});

describe("resolveStreamProvider", () => {
  it("prefers stream field over manifest default", () => {
    expect(
      resolveStreamProvider({ spec_path: "a.md", provider: "claude", touches: [] }, "cursor"),
    ).toEqual({ provider: "claude" });
  });

  it("falls back to manifest default when stream omits provider", () => {
    expect(resolveStreamProvider({ spec_path: "a.md", touches: [] }, "codex")).toEqual({
      provider: "codex",
    });
  });

  it("returns empty when no provider is configured", () => {
    expect(resolveStreamProvider({ spec_path: "a.md", touches: [] })).toEqual({});
  });
});

describe("formatStreamTierDiagnostic", () => {
  it("renders requested tier, dispatch mapping, and degrade flags", () => {
    const line = formatStreamTierDiagnostic({
      modelTier: "opus",
      effortTier: "max",
      dispatchProvider: "cursor",
      dispatchModel: "gpt-5.4-high",
      effortDegraded: true,
      tierDegradeReason: 'cursor has no reasoning-effort analog for effort tier "max"',
    });
    expect(line).toMatch(/requested=opus\/max/);
    expect(line).toMatch(/dispatch=cursor\/gpt-5.4-high/);
    expect(line).toMatch(/effortDegraded=true/);
    expect(line).toContain("degrade=");
  });

  it("renders requested provider alongside tier fields", () => {
    const line = formatStreamTierDiagnostic({
      modelTier: "opus",
      effortTier: "max",
      provider: "claude",
    });
    expect(line).toMatch(/requested=opus\/max/);
    expect(line).toMatch(/provider=claude/);
  });

  it("renders model_id even when no tier is set", () => {
    const line = formatStreamTierDiagnostic({ modelId: "grok-4.5", provider: "cursor" });
    expect(line).toMatch(/model_id=grok-4\.5/);
    expect(line).toMatch(/provider=cursor/);
  });
});

describe("formatStreamFallbackDiagnostic", () => {
  it("returns undefined for an absent or empty log", () => {
    expect(formatStreamFallbackDiagnostic(undefined)).toBeUndefined();
    expect(formatStreamFallbackDiagnostic([])).toBeUndefined();
  });

  it("renders a hop with resolved cells and category", () => {
    const line = formatStreamFallbackDiagnostic([
      {
        from: { provider: "cursor", runtime: "cloud" },
        to: { provider: "claude", runtime: "local" },
        category: "gateway-auth",
        at: "2026-07-13T00:00:00.000Z",
      },
    ]);
    expect(line).toBe("fallback: cloud/cursor → local/claude on gateway-auth");
  });

  it("renders a skip with its reason and a pinned model", () => {
    const line = formatStreamFallbackDiagnostic([
      {
        skipped: { provider: "claude", runtime: "cloud", modelId: "opus" },
        reason: "ANTHROPIC_API_KEY not set",
        at: "2026-07-13T00:00:00.000Z",
      },
    ]);
    expect(line).toBe("skipped cloud/claude:opus: ANTHROPIC_API_KEY not set");
  });

  it("renders a retry", () => {
    const line = formatStreamFallbackDiagnostic([
      {
        retried: { provider: "cursor", runtime: "cloud" },
        reason: "sdk-throw",
        at: "2026-07-13T00:00:00.000Z",
      },
    ]);
    expect(line).toBe("retried cloud/cursor once on sdk-throw");
  });

  it("renders resolved fromModel/toModel on a hop", () => {
    const line = formatStreamFallbackDiagnostic([
      {
        from: { provider: "cursor", runtime: "cloud" },
        to: { provider: "claude", runtime: "local" },
        fromModel: "claude-opus-4-8",
        toModel: "claude-sonnet-4-6",
        category: "sdk-throw",
        at: "2026-07-13T00:00:00.000Z",
      },
    ]);
    expect(line).toBe(
      "fallback: cloud/cursor:claude-opus-4-8 → local/claude:claude-sonnet-4-6 on sdk-throw",
    );
  });

  it("joins multiple records in order", () => {
    const line = formatStreamFallbackDiagnostic([
      {
        retried: { provider: "cursor", runtime: "cloud" },
        reason: "sdk-throw",
        at: "2026-07-13T00:00:00.000Z",
      },
      {
        from: { provider: "cursor", runtime: "cloud" },
        to: { provider: "claude", runtime: "local" },
        category: "sdk-throw",
        at: "2026-07-13T00:01:00.000Z",
      },
    ]);
    expect(line).toBe(
      "retried cloud/cursor once on sdk-throw; fallback: cloud/cursor → local/claude on sdk-throw",
    );
  });
});

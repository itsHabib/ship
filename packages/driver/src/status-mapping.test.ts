/** Tests for tier resolution helpers in status-mapping. */

import { describe, expect, it } from "vitest";

import { formatStreamTierDiagnostic, resolveStreamTier } from "./status-mapping.js";

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
});

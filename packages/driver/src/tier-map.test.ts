/** Tests for `mapTierToDispatch`. */

import { describe, expect, test } from "vitest";

import { mapTierToDispatch } from "./tier-map.js";

describe("mapTierToDispatch", () => {
  test("cursor opus tier maps to claude-opus-4-8 without effort params", () => {
    expect(mapTierToDispatch("cursor", "opus")).toEqual({
      model: "claude-opus-4-8",
    });
  });

  test("cursor opus + max maps effort to the model's effort parameter, undegraded", () => {
    expect(mapTierToDispatch("cursor", "opus", "max")).toEqual({
      model: "claude-opus-4-8",
      modelParams: [{ id: "effort", value: "max" }],
    });
  });

  test("cursor opus + extra maps to effort xhigh", () => {
    expect(mapTierToDispatch("cursor", "opus", "extra")).toEqual({
      model: "claude-opus-4-8",
      modelParams: [{ id: "effort", value: "xhigh" }],
    });
  });

  test("cursor opus + ultracode dispatches at max effort with multi-agent degrade", () => {
    const mapped = mapTierToDispatch("cursor", "opus", "ultracode");
    expect(mapped.model).toBe("claude-opus-4-8");
    expect(mapped.modelParams).toEqual([{ id: "effort", value: "max" }]);
    expect(mapped.degrade?.effortDegraded).toBe(true);
    expect(mapped.degrade?.reason).toContain("multi-agent");
  });

  test("cursor fable tier maps to composer-2.5 fast", () => {
    expect(mapTierToDispatch("cursor", "fable")).toEqual({
      model: "composer-2.5",
      modelParams: [{ id: "fast", value: "true" }],
    });
  });

  test("cursor effort tiers degrade with recorded reason", () => {
    const mapped = mapTierToDispatch("cursor", "sonnet", "max");
    expect(mapped.model).toBe("composer-2.5");
    expect(mapped.degrade?.effortDegraded).toBe(true);
    expect(mapped.degrade?.reason).toContain("no reasoning-effort analog");
  });

  test("cursor ultracode effort adds multi-agent degrade note", () => {
    const mapped = mapTierToDispatch("cursor", undefined, "ultracode");
    expect(mapped.degrade?.effortDegraded).toBe(true);
    expect(mapped.degrade?.reason).toContain("multi-agent");
  });

  test("claude maps model and effort to modelParams", () => {
    expect(mapTierToDispatch("claude", "opus", "max")).toEqual({
      model: "claude-opus-4-8",
      modelParams: [{ id: "reasoning", value: "high" }],
    });
  });

  test("claude ultracode degrades to max effort", () => {
    const mapped = mapTierToDispatch("claude", "sonnet", "ultracode");
    expect(mapped.model).toBe("claude-sonnet-4-6");
    expect(mapped.modelParams).toEqual([{ id: "reasoning", value: "high" }]);
    expect(mapped.degrade?.effortDegraded).toBe(true);
    expect(mapped.degrade?.reason).toContain("multi-agent");
  });

  test("unknown provider passthrough degrades without model override", () => {
    expect(mapTierToDispatch("codex", "opus", "max")).toEqual({
      degrade: {
        modelDegraded: true,
        effortDegraded: true,
        reason: 'no tier mapping for provider "codex"; using engine default',
      },
    });
  });

  test("empty tiers yield empty mapping", () => {
    expect(mapTierToDispatch("cursor")).toEqual({});
  });
});

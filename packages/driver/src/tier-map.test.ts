/** Tests for `mapTierToDispatch`. */

import { describe, expect, test } from "vitest";

import { mapTierToDispatch } from "./tier-map.js";

describe("mapTierToDispatch", () => {
  test("cursor opus tier maps to claude-opus-4-8 without effort params", () => {
    expect(mapTierToDispatch("cursor", "opus")).toEqual({
      model: "claude-opus-4-8",
    });
  });

  test("cursor opus + max emits the full effort variant tuple, undegraded", () => {
    expect(mapTierToDispatch("cursor", "opus", "max")).toEqual({
      model: "claude-opus-4-8",
      modelParams: [
        { id: "cyber", value: "false" },
        { id: "thinking", value: "false" },
        { id: "context", value: "300k" },
        { id: "effort", value: "max" },
        { id: "fast", value: "false" },
      ],
    });
  });

  test("cursor opus + extra maps to effort xhigh within the full tuple", () => {
    const mapped = mapTierToDispatch("cursor", "opus", "extra");
    expect(mapped.model).toBe("claude-opus-4-8");
    expect(mapped.modelParams).toContainEqual({ id: "effort", value: "xhigh" });
    expect(mapped.modelParams).toHaveLength(5);
    expect(mapped.degrade).toBeUndefined();
  });

  test("cursor opus + ultracode dispatches at max effort with multi-agent degrade", () => {
    const mapped = mapTierToDispatch("cursor", "opus", "ultracode");
    expect(mapped.model).toBe("claude-opus-4-8");
    expect(mapped.modelParams).toContainEqual({ id: "effort", value: "max" });
    expect(mapped.modelParams).toHaveLength(5);
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
      modelParams: [{ id: "reasoning", value: "max" }],
    });
  });

  test("claude extra effort maps to xhigh", () => {
    expect(mapTierToDispatch("claude", "opus", "extra")).toEqual({
      model: "claude-opus-4-8",
      modelParams: [{ id: "reasoning", value: "xhigh" }],
    });
  });

  test("claude ultracode degrades to max effort", () => {
    const mapped = mapTierToDispatch("claude", "sonnet", "ultracode");
    expect(mapped.model).toBe("claude-sonnet-4-6");
    expect(mapped.modelParams).toEqual([{ id: "reasoning", value: "max" }]);
    expect(mapped.degrade?.effortDegraded).toBe(true);
    expect(mapped.degrade?.reason).toContain("multi-agent");
  });

  test("unknown provider tier + effort degrades both with recorded reasons", () => {
    expect(mapTierToDispatch("codex", "opus", "max")).toEqual({
      degrade: {
        modelDegraded: true,
        effortDegraded: true,
        reason:
          'no tier mapping for provider "codex"; using engine default; no effort mapping for provider "codex"; effort tier dropped',
      },
    });
  });

  test("empty tiers yield empty mapping", () => {
    expect(mapTierToDispatch("cursor")).toEqual({});
  });

  describe("model_id passthrough", () => {
    test("cursor model_id alone dispatches verbatim without params", () => {
      expect(mapTierToDispatch("cursor", undefined, undefined, "grok-4.5")).toEqual({
        model: "grok-4.5",
      });
    });

    test("cursor model_id wins over model tier for selection", () => {
      // opus tier would map to claude-opus-4-8; the id overrides it.
      expect(mapTierToDispatch("cursor", "opus", undefined, "grok-4.5")).toEqual({
        model: "grok-4.5",
      });
    });

    test("cursor grok-4.5 + max maps to grok's high via its own variant tuple", () => {
      expect(mapTierToDispatch("cursor", undefined, "max", "grok-4.5")).toEqual({
        model: "grok-4.5",
        modelParams: [
          { id: "effort", value: "high" },
          { id: "fast", value: "false" },
        ],
      });
    });

    test("cursor grok-4.5 + extra maps to grok's medium", () => {
      const mapped = mapTierToDispatch("cursor", undefined, "extra", "grok-4.5");
      expect(mapped.model).toBe("grok-4.5");
      expect(mapped.modelParams).toContainEqual({ id: "effort", value: "medium" });
      expect(mapped.degrade).toBeUndefined();
    });

    test("cursor grok-4.5 + ultracode degrades to grok's high ceiling", () => {
      const mapped = mapTierToDispatch("cursor", undefined, "ultracode", "grok-4.5");
      expect(mapped.model).toBe("grok-4.5");
      expect(mapped.modelParams).toContainEqual({ id: "effort", value: "high" });
      expect(mapped.degrade?.effortDegraded).toBe(true);
      expect(mapped.degrade?.reason).toContain("grok-4.5");
    });

    test("cursor unknown model_id + effort passes model through, degrades effort", () => {
      const mapped = mapTierToDispatch("cursor", undefined, "max", "some-future-model");
      expect(mapped.model).toBe("some-future-model");
      expect(mapped.modelParams).toBeUndefined();
      expect(mapped.degrade?.effortDegraded).toBe(true);
      expect(mapped.degrade?.reason).toContain("no reasoning-effort analog");
    });

    test("claude model_id passes through verbatim with reasoning param", () => {
      expect(mapTierToDispatch("claude", undefined, "max", "claude-opus-4-8")).toEqual({
        model: "claude-opus-4-8",
        modelParams: [{ id: "reasoning", value: "max" }],
      });
    });

    test("claude model_id wins over model tier", () => {
      // fable tier would map to claude-sonnet-4-6; the id overrides it.
      expect(mapTierToDispatch("claude", "fable", undefined, "claude-opus-4-8")).toEqual({
        model: "claude-opus-4-8",
      });
    });

    test("unknown provider model_id-only passes through with NO degrade", () => {
      // Nothing is downgraded: the id dispatches verbatim, no tier to map,
      // no effort to apply. Must not surface as degraded status.
      expect(mapTierToDispatch("codex", undefined, undefined, "gpt-5.2-codex")).toEqual({
        model: "gpt-5.2-codex",
      });
    });

    test("unknown provider model_id + effort passes model through, degrading only effort", () => {
      expect(mapTierToDispatch("codex", undefined, "max", "gpt-5.2-codex")).toEqual({
        model: "gpt-5.2-codex",
        degrade: {
          modelDegraded: false,
          effortDegraded: true,
          reason: 'no effort mapping for provider "codex"; effort tier dropped',
        },
      });
    });
  });
});

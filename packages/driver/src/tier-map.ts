/**
 * Policy table: manifest model/effort tiers → `ShipInput` fields per provider.
 *
 * The driver performs no inference — callers supply tiers; this module maps
 * them to concrete runner knobs. Unknown provider cells degrade to engine
 * defaults with a recorded reason.
 */

import type { ShipInput } from "@ship/core";
import type { AgentProvider } from "@ship/workflow";

import type { EffortTier, ModelTier } from "./manifest.js";
import type { TierDegrade, TierDispatchResult } from "./types.js";

type ModelParam = NonNullable<ShipInput["modelParams"]>[number];

// Cursor ids from GET /v1/models (see packages/core/src/default-wiring.ts).
// Retired ids are rejected at agent.send with [invalid_model] — verify a
// cell against the live list before changing it.
const CURSOR_MODEL_BY_TIER: Record<
  ModelTier,
  { model: string; modelParams?: NonNullable<ShipInput["modelParams"]> }
> = {
  fable: {
    model: "composer-2.5",
    modelParams: [{ id: "fast", value: "true" }],
  },
  sonnet: { model: "composer-2.5" },
  opus: { model: "claude-opus-4-8" },
};

// Cursor models exposing a reasoning-effort parameter; composer ids don't.
const CURSOR_MODELS_WITH_EFFORT = new Set(["claude-opus-4-8"]);

const CURSOR_EFFORT_VALUE_BY_TIER: Record<Exclude<EffortTier, "ultracode">, string> = {
  extra: "xhigh",
  max: "max",
};

const CLAUDE_MODEL_BY_TIER: Record<ModelTier, string> = {
  fable: "claude-sonnet-4-6",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

const CLAUDE_REASONING_BY_EFFORT: Record<Exclude<EffortTier, "ultracode">, string> = {
  extra: "low",
  max: "high",
};

/** Map resolved stream tiers to `ShipInput` model fields for the given provider. */
export function mapTierToDispatch(
  provider: AgentProvider,
  modelTier?: ModelTier,
  effortTier?: EffortTier,
): TierDispatchResult {
  if (modelTier === undefined && effortTier === undefined) {
    return {};
  }
  if (provider === "cursor") {
    return mapCursorTier(modelTier, effortTier);
  }
  if (provider === "claude") {
    return mapClaudeTier(modelTier, effortTier);
  }
  return unknownProviderDegrade(provider, modelTier, effortTier);
}

function mapCursorTier(
  modelTier: ModelTier | undefined,
  effortTier: EffortTier | undefined,
): TierDispatchResult {
  let model: string | undefined;
  let modelParams: NonNullable<ShipInput["modelParams"]> | undefined;

  if (modelTier !== undefined) {
    const mapped = CURSOR_MODEL_BY_TIER[modelTier];
    model = mapped.model;
    modelParams = mapped.modelParams;
  }

  if (effortTier === undefined) {
    return buildDispatchResult(model, modelParams);
  }

  if (model === undefined || !CURSOR_MODELS_WITH_EFFORT.has(model)) {
    return buildDispatchResult(model, modelParams, {
      effortDegraded: true,
      reason: cursorEffortDegradeReason(model, effortTier),
    });
  }

  const value = effortTier === "ultracode" ? "max" : CURSOR_EFFORT_VALUE_BY_TIER[effortTier];
  modelParams = appendParam(modelParams, { id: "effort", value });

  if (effortTier !== "ultracode") {
    return buildDispatchResult(model, modelParams);
  }

  return buildDispatchResult(model, modelParams, {
    effortDegraded: true,
    reason:
      'cursor has no multi-agent analog for effort tier "ultracode"; dispatching at max effort',
  });
}

function cursorEffortDegradeReason(model: string | undefined, effortTier: EffortTier): string {
  const parts = [
    `cursor model "${model ?? "engine default"}" has no reasoning-effort analog for effort tier "${effortTier}"`,
  ];
  if (effortTier === "ultracode") {
    parts.push('cursor has no multi-agent analog for effort tier "ultracode"');
  }
  return parts.join("; ");
}

function mapClaudeTier(
  modelTier: ModelTier | undefined,
  effortTier: EffortTier | undefined,
): TierDispatchResult {
  const degradeParts: string[] = [];
  const degrade: TierDegrade = {};

  let model: string | undefined;
  let modelParams: NonNullable<ShipInput["modelParams"]> | undefined;

  if (modelTier !== undefined) {
    model = CLAUDE_MODEL_BY_TIER[modelTier];
  }

  if (effortTier === "ultracode") {
    degrade.effortDegraded = true;
    degradeParts.push(
      "ultracode implies a multi-agent path; dispatching at max effort until engine support exists",
    );
    modelParams = appendParam(modelParams, reasoningParam("high"));
    return buildDispatchResult(model, modelParams, {
      ...degrade,
      reason: degradeParts.join("; "),
    });
  }

  if (effortTier !== undefined) {
    modelParams = appendParam(modelParams, reasoningParam(CLAUDE_REASONING_BY_EFFORT[effortTier]));
  }

  if (degradeParts.length === 0) {
    return buildDispatchResult(model, modelParams);
  }

  degrade.reason = degradeParts.join("; ");
  return buildDispatchResult(model, modelParams, degrade);
}

function unknownProviderDegrade(
  provider: AgentProvider,
  modelTier: ModelTier | undefined,
  effortTier: EffortTier | undefined,
): TierDispatchResult {
  const parts: string[] = [`no tier mapping for provider "${provider}"; using engine default`];
  const degrade: TierDegrade = {
    modelDegraded: modelTier !== undefined,
    effortDegraded: effortTier !== undefined,
    reason: parts.join("; "),
  };
  return { degrade };
}

function reasoningParam(value: string): ModelParam {
  return { id: "reasoning", value };
}

function appendParam(
  existing: NonNullable<ShipInput["modelParams"]> | undefined,
  param: ModelParam,
): NonNullable<ShipInput["modelParams"]> {
  if (existing === undefined) {
    return [param];
  }
  return [...existing.filter((entry) => entry.id !== param.id), param];
}

function buildDispatchResult(
  model?: string,
  modelParams?: NonNullable<ShipInput["modelParams"]>,
  degrade?: TierDegrade,
): TierDispatchResult {
  const out: TierDispatchResult = {};
  if (model !== undefined) out.model = model;
  if (modelParams !== undefined) out.modelParams = modelParams;
  if (degrade !== undefined) out.degrade = degrade;
  return out;
}

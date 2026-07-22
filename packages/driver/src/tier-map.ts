/**
 * Policy table: manifest model/effort tiers → `ShipInput` fields per provider.
 *
 * The driver performs no inference — callers supply tiers (and optionally a
 * verbatim `modelId`, which wins over the tier for model selection); this
 * module maps them to concrete runner knobs. Unknown provider cells degrade
 * to engine defaults with a recorded reason.
 *
 * "tier" here is the model/effort DISPATCH tier (opus/sonnet/fable,
 * extra/max/ultracode) — which model runs the work. It is NOT the review-risk
 * "triage tier" (T0–T3) from triage.ts, which sizes how much review a PR needs
 * and never touches dispatch. Two concepts, one overloaded word — kept apart by
 * name (`ModelTier`/`EffortTier` here, `TriageTier` there).
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

// Per-model-id effort capability (model-lottery spec §3.4): how a known
// cursor id expresses reasoning effort, keyed by the id that dispatches —
// tier-mapped and passthrough ids hit the same row. Ids absent from the
// table dispatch with no effort params + a recorded degrade; adding a model
// is one row here, only needed when effort control for it is wanted.
interface ModelCapability {
  effortValueByTier: Record<Exclude<EffortTier, "ultracode">, string>;
  ultracode: { value: string; reason: string };
  params: (effortValue: string) => NonNullable<ShipInput["modelParams"]>;
}

const CURSOR_CAPABILITY_BY_MODEL_ID: Record<string, ModelCapability> = {
  "claude-opus-4-8": {
    effortValueByTier: { extra: "xhigh", max: "max" },
    params: cursorEffortVariantParams,
    ultracode: {
      reason:
        'cursor has no multi-agent analog for effort tier "ultracode"; dispatching at max effort',
      value: "max",
    },
  },
  // Verified against GET /v1/models 2026-07-12; variant tuple is
  // (effort: low|medium|high, fast). No max/xhigh analog — manifest tiers
  // map to grok's nearest values.
  "grok-4.5": {
    effortValueByTier: { extra: "medium", max: "high" },
    params: grokEffortVariantParams,
    ultracode: {
      reason:
        'cursor has no multi-agent analog for effort tier "ultracode"; dispatching grok-4.5 at high effort',
      value: "high",
    },
  },
};

const CLAUDE_MODEL_BY_TIER: Record<ModelTier, string> = {
  fable: "claude-sonnet-4-6",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

// Claude effort analogs (SDK EffortLevel): extra = xhigh (single-agent deep,
// falls back to high on models without it), max = the SDK maximum. These are
// consumed by the claude local runner as the query effort option.
const CLAUDE_REASONING_BY_EFFORT: Record<Exclude<EffortTier, "ultracode">, string> = {
  extra: "xhigh",
  max: "max",
};

/** Map resolved stream tiers to `ShipInput` model fields for the given provider. */
export function mapTierToDispatch(
  provider: AgentProvider,
  modelTier?: ModelTier,
  effortTier?: EffortTier,
  modelId?: string,
): TierDispatchResult {
  if (modelTier === undefined && effortTier === undefined && modelId === undefined) {
    return {};
  }
  if (provider === "cursor") {
    return mapCursorTier(modelTier, effortTier, modelId);
  }
  if (provider === "claude") {
    return mapClaudeTier(modelTier, effortTier, modelId);
  }
  return unknownProviderDegrade(provider, modelTier, effortTier, modelId);
}

function mapCursorTier(
  modelTier: ModelTier | undefined,
  effortTier: EffortTier | undefined,
  modelId: string | undefined,
): TierDispatchResult {
  // modelId wins for model selection (spec §3.1): verbatim, no tier params.
  let model: string | undefined = modelId;
  let modelParams: NonNullable<ShipInput["modelParams"]> | undefined;

  if (model === undefined && modelTier !== undefined) {
    const mapped = CURSOR_MODEL_BY_TIER[modelTier];
    model = mapped.model;
    modelParams = mapped.modelParams;
  }

  if (effortTier === undefined) {
    return buildDispatchResult(model, modelParams);
  }

  const capability = model === undefined ? undefined : CURSOR_CAPABILITY_BY_MODEL_ID[model];
  if (capability === undefined) {
    return buildDispatchResult(model, modelParams, {
      effortDegraded: true,
      reason: cursorEffortDegradeReason(model, effortTier),
    });
  }

  const value =
    effortTier === "ultracode"
      ? capability.ultracode.value
      : capability.effortValueByTier[effortTier];
  // Cursor variant matching is exact on the FULL param tuple: a lone effort
  // param matches no listed variant and agent.send rejects it as
  // invalid_model. Emit every parameter of the target variant.
  modelParams = capability.params(value);

  if (effortTier !== "ultracode") {
    return buildDispatchResult(model, modelParams);
  }

  return buildDispatchResult(model, modelParams, {
    effortDegraded: true,
    reason: capability.ultracode.reason,
  });
}

// The claude-family variant tuple on cursor (GET /v1/models, 2026-07-02):
// cyber/thinking/context/effort/fast. Values other than effort are pinned to
// the default variant's.
function cursorEffortVariantParams(effort: string): NonNullable<ShipInput["modelParams"]> {
  return [
    { id: "cyber", value: "false" },
    { id: "thinking", value: "false" },
    { id: "context", value: "300k" },
    { id: "effort", value: effort },
    { id: "fast", value: "false" },
  ];
}

function grokEffortVariantParams(effort: string): NonNullable<ShipInput["modelParams"]> {
  // `fast` is pinned off: ship tasks are long-running, so grok's fast mode
  // (the analog of the cursor `fable` tier) never fits a dispatch. A future
  // `grok-4.5-fast`-style capability row would flip this.
  return [
    { id: "effort", value: effort },
    { id: "fast", value: "false" },
  ];
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
  modelId: string | undefined,
): TierDispatchResult {
  const degradeParts: string[] = [];
  const degrade: TierDegrade = {};

  // modelId wins for model selection (spec §3.1); no cross-provider
  // translation — an id the claude runner doesn't know fails at dispatch
  // with the provider's error (spec §3.3).
  let model: string | undefined = modelId;
  let modelParams: NonNullable<ShipInput["modelParams"]> | undefined;

  if (model === undefined && modelTier !== undefined) {
    model = CLAUDE_MODEL_BY_TIER[modelTier];
  }

  if (effortTier === "ultracode") {
    degrade.effortDegraded = true;
    degradeParts.push(
      "ultracode implies a multi-agent path; dispatching at max effort until engine support exists",
    );
    const capped = capClaudeMaxEffort(model, "max");
    if (capped.reason !== undefined) {
      degradeParts.push(capped.reason);
    }
    modelParams = appendParam(modelParams, reasoningParam(capped.value));
    return buildDispatchResult(model, modelParams, {
      ...degrade,
      reason: degradeParts.join("; "),
    });
  }

  if (effortTier !== undefined) {
    const capped = capClaudeMaxEffort(model, CLAUDE_REASONING_BY_EFFORT[effortTier]);
    if (capped.reason !== undefined) {
      degrade.effortDegraded = true;
      degradeParts.push(capped.reason);
    }
    modelParams = appendParam(modelParams, reasoningParam(capped.value));
  }

  if (degradeParts.length === 0) {
    return buildDispatchResult(model, modelParams);
  }

  degrade.reason = degradeParts.join("; ");
  return buildDispatchResult(model, modelParams, degrade);
}

// Models known to accept the SDK's model-specific "max" effort. Unlike xhigh
// (which the SDK downgrades gracefully on models without it), an unsupported
// max rejects the dispatch — so max is gated by id: known-capable ids keep it,
// anything else (verbatim ids of unknown capability, the engine default)
// degrades to high with a recorded reason.
const CLAUDE_MAX_EFFORT_MODEL_IDS = new Set(["claude-opus-4-8", "claude-sonnet-4-6"]);

function capClaudeMaxEffort(
  model: string | undefined,
  value: string,
): { value: string; reason?: string } {
  if (value !== "max") return { value };
  if (model !== undefined && CLAUDE_MAX_EFFORT_MODEL_IDS.has(model)) return { value };
  return {
    reason: `model "${model ?? "engine default"}" has unknown max-effort support; dispatching at high`,
    value: "high",
  };
}

function unknownProviderDegrade(
  provider: AgentProvider,
  modelTier: ModelTier | undefined,
  effortTier: EffortTier | undefined,
  modelId: string | undefined,
): TierDispatchResult {
  // A verbatim id passes through unchanged (spec §3.3). An unknown provider
  // has no tier map and no effort knob, so a model_id-only run degrades
  // nothing — return the passthrough model with no degrade rather than a
  // misleading "using engine default" that would surface as degraded status.
  const modelDegraded = modelId === undefined && modelTier !== undefined;
  const effortDegraded = effortTier !== undefined;
  const model = modelId;

  if (!modelDegraded && !effortDegraded) {
    return model === undefined ? {} : { model };
  }

  const parts: string[] = [];
  if (modelDegraded) {
    parts.push(`no tier mapping for provider "${provider}"; using engine default`);
  }
  if (effortDegraded) {
    parts.push(`no effort mapping for provider "${provider}"; effort tier dropped`);
  }
  const degrade: TierDegrade = { modelDegraded, effortDegraded, reason: parts.join("; ") };
  return model === undefined ? { degrade } : { degrade, model };
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

# Model lottery — `model_id` passthrough + stratified pool assignment

**Status:** draft / design review — no implementation in this PR.
**Owner:** @itsHabib
**Date:** 2026-07-13
**Related:** friction F4 (2026-07-13 runway run, P1), `docs/features/dispatch-fallback/spec.md`
(PR #201 — shares the dispatch-target vocabulary, see §7), the runway phase-1 experiment readout
(workbench `docs/features/runway-1-local-controller/driver.md`), dossier tasks
`driver-model-id-passthrough` + `work-driver-prep-model-pool`.

> **Reviewers — focus areas:** §3.1 (precedence when both `model` tier and `model_id` are set),
> §3.2 (unknown-id failure mode), §4 (the assignment verb staying round-robin-only), §5
> (preflight staying warning-grade), §7 (target-shape convergence with PR #201).

## 1. Problem

The driver manifest's model field is a closed 3-value tier enum (`opus|sonnet|fable`) that
`tier-map.ts` maps to concrete provider ids. Any real provider catalog id outside the map is
unexpressible: the 2026-07-13 runway run dispatched grok-4.5 only via an uncommitted local patch
that polluted the tier enum with a literal model id (friction F4, P1). That patch is the wrong
shape — every new model would grow the enum, the store schema, and every switch on it.

The consumer this unblocks is the operator-endorsed next experiment: fan same-sized streams
across models (grok / opus / composer), compare review-cycle and intervention cost via
`/provenance`. That needs (a) a manifest that can name any model, (b) a cheap deterministic way
to spread a pool of models over a batch's streams, and (c) the literal model id surviving into
`driver_streams`, receipts, and the PR Provenance footer.

**Simplicity constraint (operator):** do not over-build. Round-robin is the whole assignment
algorithm. Runtime judgment (dead credential, model unavailable, seat preference) stays with the
driver seat, not encoded policy.

**Non-goals:** no weights, buckets, or seeded sampling; no per-model cost tracking; no new
doctor subcommand; no cross-provider model translation (a model id is meaningful only with its
provider); no changes to `decide` verbs.

## 2. Shape overview

```
manifest stream: { provider?, model? (tier), model_id?, effort? }
        │ import (verbatim string; no catalog validation)
        ▼
driver_streams: model_id column (requested), dispatch_model (what actually went out)
        │ tick → buildShipInput → mapTierToDispatch(provider, tier, effort, modelId)
        ▼
model_id present → dispatch it verbatim; effort maps via per-model capability row,
                   else degrades with a recorded reason
model_id absent  → today's tier path, byte-identical
```

A **dispatch target** is `(runtime, provider, model_id?)` — the same vocabulary PR #201's
fallback-chain entries use (§7). A **pool member** is the `(provider, model_id)` slice of one.

## 3. Key decisions — passthrough (phase 1)

### 3.1 `model_id` alongside the tier; `model_id` wins

Per-stream (and run-level `default_model_id`) optional string field, verbatim provider catalog
id. When both `model` (tier) and `model_id` are present, **`model_id` wins for model selection**
and the tier contributes nothing — one knob decides, no blending. Import records no error:
prep tooling legitimately stamps `model_id` over a manifest that already carried a default tier.
`effort` remains an independent tier and maps per §3.4.

**Alternative rejected:** an `x-model` escape hatch *inside* the tier map (a config-level
tier→id override). It moves policy into config, can't vary per stream, and the runway experiment
showed per-stream is the unit that matters. **Also rejected:** mutual exclusion (schema error
when both present) — it forces prep tooling to strip tiers before stamping ids, pure friction.

The grok-4.5 enum pollution from the local patch is **reverted**, not folded in: the tier enum
returns to `opus|sonnet|fable`. Its useful cargo — the grok effort-variant tuple and ceilings —
moves into the per-model capability table (§3.4). The claude-provider "grok degrades to opus"
cell is dropped: cross-provider translation is exactly what `model_id` makes unnecessary
(§3.3).

### 3.2 Unknown ids are the provider's problem, not the schema's

`model_id` is schema-validated as a non-empty string only. Ship does not gate it against a
catalog: cursor's list is live (`GET /v1/models` — ids appear and retire weekly), and a stale
local allowlist would reject valid ids (the exact F4 failure mode, reinvented). An invalid id
fails at dispatch with the provider's error (cursor: `[invalid_model]`), which the existing
failure path classifies and surfaces on the stream — a legible dispatch error, not a schema
rejection. Preflight (§5) is the cheap advisory layer that catches typos *before* dispatch when
the seat wants it.

### 3.3 `model_id` is provider-scoped; no translation

`(provider, model_id)` travel together. A claude-provider stream with `model_id: grok-4.5`
dispatches verbatim and fails with the provider's unknown-model error — same as any typo. The
engine never guesses "what this model means on that provider." This keeps the tier map's
passthrough branch one line instead of a translation matrix, and it is the property that lets a
pool mix single-provider members (cursor:grok-4.5, cursor:claude-opus-4-8) and true
multi-provider members (claude:claude-opus-4-8, codex:gpt-5.2-codex) with zero dispatcher
changes — the dispatcher already routes by provider.

### 3.4 Effort maps per-model via a capability table

`tier-map.ts` gains a small per-model-id capability table (the local patch's grok tuple,
generalized): for known ids, the effort tier maps to that model's variant tuple (grok:
`extra→medium`, `max→high`, `ultracode→high + effortDegraded`; the claude-family cursor tuple
unchanged). For **unknown** ids with an effort tier set, the model dispatches verbatim with no
effort params and `effortDegraded: true` + reason (`no effort mapping for model_id "X"`) — the
existing degrade channel, never a failure. Capability rows are additive maintenance, ~5 lines
per model, only needed when someone wants effort control for that model.

### 3.5 Attribution: requested vs dispatched

Two facts, two columns. `model_id` (new, nullable) records what the manifest requested;
`dispatch_model` / `dispatch_model_params` (existing) keep recording what actually went out.
They differ exactly when something degraded or the seat overrode — that delta is the audit
trail. The PR Provenance footer derives from the dispatched truth:
`implementer=<dispatch_model> provider=<dispatch_provider>`, so `/provenance` and the
comparison readout need zero archaeology. Receipts carry the same pair.

## 4. Key decisions — assignment (phase 2)

### 4.1 `ship driver assign --pool <provider:model,...> <manifest>`

A code-level verb, not skill prose: reads the manifest, walks **streams in manifest order**
(batch order, then stream order), stamps `provider` + `model_id` round-robin from the pool,
writes the manifest back (frontmatter edit, same write-back seam the engine already uses for
status). Deterministic: same manifest + same pool → same assignment, byte-for-byte. No seeds,
no weights, no balancing heuristics. Prints the assignment table it produced.

Already-terminal streams (`done` / `skipped`) are not restamped; pending/todo streams are. The
verb is idempotent for a given pool and re-runnable after manifest edits.

**Alternative rejected:** assignment logic in the `/work-driver-prep` skill prose. The skill
becomes a thin caller (`--model-pool` flag shells to the verb); if the skill text needs more
than one sentence to describe the rotation, the boundary is wrong. **Also rejected:** stratified
buckets / weighted draws — nothing in the experiment design needs them, and the operator said
round-robin is the whole algorithm.

### 4.2 Seat override is policy, not engine code

The driver seat may re-stamp any stream's assignment at runtime (dead credential, unavailable
model, its own judgment) by editing the manifest / re-running `assign` on a narrower pool.
The engine encodes no override rules; it just dispatches what the stream says and records what
actually went out (§3.5). This is the same policy/mechanism split as tier selection.

## 5. Preflight — cheap, advisory, shared shape with #201

`assign --preflight` (default on, `--no-preflight` to skip): per unique pool member, verify
reachability — cursor ids against `GET /v1/models` (the proven check from the grok run);
non-cursor members by credential presence in env (`ANTHROPIC_*`, codex equivalent). A failed
member is **dropped with a recorded note** in the manifest's advisory block and round-robin
continues over the survivors. Preflight never blocks the batch and never mutates anything but
the assignment it was already computing. It is a warning-grade check inside an existing verb —
explicitly not a new doctor subcommand.

This is the same check PR #201 §4.4 runs at hop time (skip-unviable-target-with-recorded-
reason). One mechanism, two call sites: a `checkTargetViability(target) → { viable } | {
skipped: reason }` helper in `packages/driver`, called by `assign` at prep time and by the
fallback walk at hop time. Whichever PR lands second wires itself to the helper the first one
created.

## 6. Data model & API contract

**Manifest** (`packages/driver/src/manifest.ts`): per-stream `model_id: z.string().min(1).optional()`,
run-level `default_model_id` (inheritance mirrors `default_model`); tier enum reverts to
`opus|sonnet|fable`. Tier-only manifests parse and dispatch byte-identically.

**Store** (`packages/store/src/driver-schemas.ts` + `driver-streams.ts`): additive nullable
`model_id` column on `driver_streams`; enum revert in `driverModelTierSchema`. Existing DBs
open unchanged. (The runway rows predate the column; their `dispatch_model` already carries the
truth.)

**Tier map:** `mapTierToDispatch(provider, modelTier, effortTier, modelId?)` — `modelId`
short-circuits model selection; effort resolves via the capability table (§3.4).

**CLI/MCP:** `driver assign` is the only new verb. `driver status` / list views render
`model_id` where they render `modelTier` today. No `decide` changes.

**Skill:** `/work-driver-prep --model-pool cursor:grok-4.5,cursor:claude-opus-4-8,...` shells
to `ship driver assign` after manifest generation. One sentence of prose.

## 7. Convergence with PR #201 (dispatch fallback chain)

Both features need to name "where a stream dispatches." Converged shape: **a dispatch target is
`(runtime, provider, model_id?)`** — #201's chain entries gain the optional `model_id` member
(absent → the provider's engine-default model, exactly like a stream without one), and this
feature's pool members are the `(provider, model_id)` slice with runtime taken from the stream.
Shared code: the target type lives in `packages/driver`, and the §5 viability helper serves
both call sites. Neither feature blocks the other; the second to land adopts the first's type.
This section is the coordination artifact — #201's review should read it (cross-linked there).

## 8. Rollout

| Phase | Goal | Tasks | Gate | Scope |
| --- | --- | --- | --- | --- |
| **P1 — passthrough** | any catalog id expressible + attributable | manifest + store `model_id`; tier-map short-circuit + capability table; enum revert; render/status; tests (precedence, degrade, unknown-id dispatch error, attribution end-to-end) | local patch deleted, root checkout clean | ~300–450 wLOC |
| **P2 — assign + prep flag** | pool spread without hand-stamping | `driver assign` verb (round-robin + write-back); `--preflight` viability helper; `/work-driver-prep --model-pool`; tests (pool>streams, streams>pool, dropped member, idempotence) | — | ~250–400 wLOC |
| **P3 — the experiment** | one real mixed-model batch | prep a real 3+ task phase with `--model-pool cursor:grok-4.5,cursor:claude-opus-4-8,cursor:composer-2.5`, drive to merge, per-stream ledger in the manifest | second `/provenance` dataset exists | run, not code |

Closes `driver-model-id-passthrough` (P1) and `work-driver-prep-model-pool` (P2). The runway
verdict is the grounding: grok is viable iff second-OS verification + mandatory tri-provider
panel — P3 runs under exactly that policy. The productization brief's runner-interface and
cost-per-useful-PR framing (§4, §11) is satisfied as a side effect of §3.5: cost-by-model
queries become a `driver_streams` group-by, not archaeology.

## 9. Open questions

1. **`default_model_id` inheritance vs explicitness** — is a run-level default worth having, or
   should pool assignment always stamp per-stream (the only real consumer)? Leaning: keep it for
   symmetry with `default_model`; costs one line.
2. **Codex preflight** — credential-presence is weaker than cursor's catalog check. Good enough
   for warning-grade, or should codex members skip preflight entirely with a note?
3. **Should `assign` also stamp `runtime`?** Current answer: no — pools are `(provider, model)`;
   runtime stays the manifest author's call (`default_runtime`). #201's chains are where runtime
   variation lives.

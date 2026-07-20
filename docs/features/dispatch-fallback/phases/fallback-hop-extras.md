**Status**: draft
**Owner**: @mh
**Date**: 2026-07-20
**Related**: dossier task `fallback-hop-extras` (id: `tsk_01KXEF21A7CSEWHPFS29B0H6KF`), design [../spec.md](../spec.md) §4.7, §4.1, §5, §9 P2b

# Hop extras: transient-blip retry + model attribution (dispatch-fallback P2b) — phase doc

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/fallback-hop.ts` (retry predicate + record), `packages/driver/src/engine.ts` (both seams call the retry check first), hop-record model fields | ~150 | ~150 |
| Tests | unit (allowlist membership, one-per-target bookkeeping, ordering), e2e (retry-then-succeed, retry-then-advance, cross-provider model record) | ~200 | ~100 |
| **Total** | | | **~250** |

Band: **amazing** per repo PR sizing.

## Goal

A transient blip (connect-timeout, network flap, rate-limit) gets one same-target
retry before the chain moves, so a 10-second outage never permanently demotes a
stream off its intended target; and every hop record carries the resolved
from/to dispatch models, so cross-provider hops stay attributable in
`/provenance` and model-comparison readouts.

**Scope shrank vs the spec's P2b row (verified against main, 2026-07-20).** The
§4.1 `model_id` dispatch plumbing is ALREADY LANDED — do not rebuild it:

- The `modelId` stream column exists and `FALLBACK_RESET_PATCH` writes it from
  the hop entry (`modelId: to.modelId ?? null`, a P2a review-cycle fix — a stale
  primary model id must not ride onto a different target's dispatch).
- Dispatch honors it: `dispatchStreamOnce` passes `stream.modelId` INTO
  `mapTierToDispatch`, where a verbatim id wins over tier mapping (model-lottery
  §3.1). The spec's "read `targetModelId` after `tierDispatchPatch`" design was
  superseded by routing the id *through* the mapping; the grok-4.5 P2a drive
  proved the cursor path end-to-end.

What remains of the model half is **attribution only**: hop records carry the
*resolved* from/to models, and hopped streams are re-attributable in
model-comparison readouts.

## Behavior

**1. Transient-blip retry (§4.7).**

- v1 sensor is a **known-transient-error-shape allowlist** (connect-timeout /
  transient-network / rate-limit class), classifiable from the error in hand,
  defined next to `FALLBACK_ELIGIBLE_CATEGORIES` in `fallback-hop.ts`. NOTE:
  `isRetryable` does not exist anywhere in `packages/` — there is no SDK flag to
  key on; promoting to a first-class retryable signal stays a follow-up gated on
  ship persisting one.
- Rule: failure matches the allowlist AND the stream is pre-work (same
  `hasNoWorkProducts` gate) AND the current target is unretried → ONE
  same-target re-dispatch, recorded `{retried: target, reason, at}` in
  `fallbackLog`. **Checked FIRST — before and independent of the §4.2 category
  allowlist** (else transient non-hop categories like `contention` never reach
  it). One retry per target per lifecycle; the second failure falls through to
  the hop gate / escalation.
- Breaker interplay unchanged: ≤2 attempts (1 + 1 retry) per target stays inside
  the #199 budget; `chainStillConsumable` must account for an unused retry (a
  stream with an unretried current target is still movement-capable).
- §6 escalation copy already renders `retried <cell> once on <reason>` — the
  formatter landed in P2a; this phase makes the record it formats actually exist.

**2. Resolved from/to models on hop records (§4.1 residue).**

- Hop records **populate the existing optional `fromModel`/`toModel` schema
  fields** (the shapes landed with P1's `fallbackLogRecordSchema`; nothing
  writes them today): the *resolved* dispatch model on each side (the
  tier-mapped or verbatim id — i.e. what `dispatchModel` was/will be), not just
  the chain entry's optional `model_id`. A cross-provider hop changes the model
  even when no entry pins one; that must be attributable.
- `/provenance` and #202's model-comparison readouts can then re-attribute (or
  exclude) hopped streams — one line in the readout query, documented in the
  hop-record shape.

## Acceptance

- Transient-shape failure on a pre-work stream → one same-target retry
  (recorded), success path continues normally; a second failure on the same
  target falls through to the §4.2 hop gate — an *eligible* category advances
  the chain (or escalates when exhausted); a *non-eligible* one (e.g.
  `contention`) escalates as today, never burning a chain entry.
- `contention` (non-hop category) gets its one retry via the same path.
- Non-transient failures skip straight to the hop gate — zero behavior change.
- A hop record carries resolved `fromModel`/`toModel` whether or not the chain
  entry pinned a `model_id`; `driver status` renders them.
- ≤2 attempts per target; cursor monotonic; no chain refill; breaker budget
  intact; `chainStillConsumable` true while an unused retry remains.

## Test plan

Unit: allowlist membership (each shape class + a non-member), retry bookkeeping
(one per target, per lifecycle, across a decide-retry round-trip),
retry-before-category ordering (`contention` reaches the retry; its second
failure escalates without consuming chain), `chainStillConsumable` with an
unused retry on the current target (and false once retried + exhausted),
hop-record model resolution (pinned entry vs tier-mapped). e2e (fake runners, both seams):
transient-retry-then-succeed; transient-retry-then-advance;
cross-provider hop with and without pinned `model_id` → records + dispatch
correct.

## Out of scope

The core hop mechanism (P2a — merged; validation gate pending). Rebuilding the
`model_id` dispatch path (landed — see Scope). `decide retry --target` (P3).
Mid-run fallback (P4). A first-class persisted retryable signal (follow-up).

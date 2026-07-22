**Status**: draft
**Owner**: @michael
**Date**: 2026-07-22
**Related**: dossier task `review-spend-log` (id: `tsk_01KY4Z7B6PXN3ZGPM21WQ0S51Z`), workbench `docs/review-credit-strategy.md` Phase 0.3; depends on `driver-triage-tier` (the stream tier field is this record's key input)

# Review-spend jsonl — append-only spend events at review time — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/spend-log.ts` (new), `land.ts`, poll/review-cycle seam in `engine.ts`, `review-findings.ts` (export per-bot grouping if needed) | ~150 | 150 |
| Tests | `spend-log.test.ts` (new), engine/land flow assertions | ~200 | 100 |
| **Total** | | | **~250** |

Band: **ideal** per repo's PR sizing convention.

## Goal

Which bot earns its slot at which tier can only be settled with data, and nothing records review spend today. Records must fire at REVIEW time, not only at land — one-line-per-landed-PR silently drops closed/parked/stuck/abandoned PRs whose reviews spent credits all the same (the expensive tail the loss analysis most needs). The record also needs a cost proxy (events ≠ tokens) and an escaped-defect link.

## Behavior / fix

Append-only event lines in `review-spend.jsonl` inside ship's *resolved* state dir — the same XDG/APPDATA resolver the store uses (`<UserConfigDir>/ship/`, honoring the existing env overrides), sibling to `state.db`. Not a hardcoded `~/.ship` (that is not ship's state-dir convention on any supported surface). A FRESH file — never touch any `labels/**` file, which is the classifier oracle. Two event shapes, keyed by `{repo, pr}`:

- `review_cycle` — appended as each review cycle completes:
  `{ts, event:"review_cycle", repo, pr, head_sha, tier, tier_source, cycle, reviewers_requested[], findings_per_bot: {bot: {total, unique, critical}}, claude_cost_proxy}`
- `terminal` — appended when the PR merges or closes:
  `{ts, event:"terminal", repo, pr, tier, cycles_used, merged, fixes_pr?}`. A PR still open at analysis time has no terminal event — visible, not missing.

Details:

- Tier + tier_source come from the stream record (requires `driver-triage-tier` merged first).
- `unique` = findings not duplicated by another bot at the same file:line — reuse review-findings' grouping; don't re-judge.
- `claude_cost_proxy`: diff bytes in + claude review-body bytes out. Null for cycles with no claude review.
- `fixes_pr`: recorded when the PR body/spec explicitly declares it fixes a prior PR; null otherwise. Explicit declaration only — no inference.
- Best-effort append: a write failure warns and never blocks polling or land (instrumentation, not a gate).
- One module, small sharp API (`appendSpendEvent(event)`); poll/land call it, nothing else knows the file format.

## Acceptance

A driver run appends one valid `review_cycle` event per completed cycle (including for a PR that never merges) and exactly one `terminal` event per merged/closed PR, carrying tier, tier_source, per-bot finding counts, and the claude cost proxy; a declared fixes-PR lands in `fixes_pr`; a write failure (read-only dir in test) logs a warning and the run still completes.

## Test plan

Unit tests: both event shapes, dedupe counts, cost-proxy computation, fixes_pr extraction, failure path. Engine-flow test: cycle events fire without a land; terminal event fires once on land. `pnpm test` in packages/driver green.

## Non-goals

Analysis/reporting of the log (30-day re-evaluation is an operator/skill act later), reviewer behavior changes, hand-driven PRs (can get records via /pr-risk later if wanted).

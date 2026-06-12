**Status**: ready for impl
**Owner**: @michael
**Date**: 2026-06-12
**Related**: dossier task `driver-engine-loop` (id: `tsk_01KTWZER3KNWNJN01TPJKMN92W`); locked design [docs/features/driver-extraction/spec.md](../spec.md) — §4.1, §6, §7, §8, §9 P3. Depends on P1 (#129, `405563e`) and P2 (#130, `7bac0f8`), both on main.

# @ship/driver engine — the loop as code: walker, dispatcher, poller, judgment, resume, lease

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/store/migrations/0006_driver_tick_lease.sql` (~10), tick-lease verb on `driver-runs.ts` (~40), `packages/driver/src/ship-port.ts` (~25), `engine.ts` (~330), `judgment.ts` (~70), `service.ts` (~110), exports | ~590 | 590 |
| Tests | engine L1/L2 (fake clock + fake port), decide paths, recovery table, lease, cancel, determinism, resume | ~750 | 375 |
| Configs / docs | this doc, `package.json` dep edge | — | 0 |
| **Total** | | | **~965 — stretch band** |

**No-split justification (required > 700):** the tick is one coupled state machine — the walker decides what the dispatcher does, the poller's terminal handling is what produces judgment requests, and resume IS re-entering the same tick from persisted state. Shipping walker+dispatcher+poller without judgment/resume would ship an engine that can neither pause correctly (§7.2's drain-before-pause spans both halves) nor recover, and §11's mechanical acceptance (failed-retry, store-only resume) is unsatisfiable by either half alone.

## Goal

P1 typed the input; P2 made the store the source of truth. This phase removes the LLM from the loop itself: dep-ordered batch walking, dispatch, terminal-polling, failure routing, and resume become tested code with **zero model calls inside** — the only LLM touchpoints are judgment *exits* (spec NFR row 1). The engine ends at "streams landed, PRs known" (§4.3); reviews and merges stay policy.

## Implementation plan

1. Migration 0006 + tick-lease verb + store tests.
2. `ship-port.ts` + fake port test harness.
3. `engine.ts`: eligibility → dispatch → poll → exit evaluation (progress/done paths first).
4. `judgment.ts` + decide + §7.3 recovery + lease + cancel + markMerged.
5. Determinism + resume + full test matrix; exports; `make check` clean.

Single PR (stretch band, justified above). Title: `feat(driver): engine tick loop — walker, dispatcher, poller, judgment, resume (P3)`.

## Acceptance

- Golden-manifest walk: multi-batch fixture drives dispatch in dep order; failed-retry path; `batch` targeting.
- Two-run plan determinism.
- Store-only resume at each persisted state.
- §7.3 recovery table: zero / exactly-one / multiple candidates / at-limit.
- §7.6: `blocked_on_merges` + `markMerged` unblocks.
- Lease: live-tick refusal, stale takeover, `force`, ended-tick never blocks.
- `cancel` idempotent incl. partial cancelRun failures.
- Zero model calls; dep direction enforced.
- Coverage thresholds met; `make check` green ubuntu + windows.

## Out of scope

- CLI / MCP surfaces (P4).
- Review-cycle automation, merge execution.
- `ship driver watch` (F6), push events (F5).
- Worktree creation (policy; ED-4 fails fast instead).

**Status**: draft
**Owner**: @michael
**Date**: 2026-07-12
**Related**: dossier task `driver-multidecide-dispatching-and-cancelled-guard` (id: `tsk_01KVB6VXQ0F88QSCGANET3QVC7`); PR #141 review-coordinator verdict (cycle 1).

# Multi-decide: hold `awaiting_judgment` for dispatching streams + guard `markMerged` against terminal runs — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/judgment.ts` | ~40 | 40 |
| Tests | multi-failure adopt case, cancelled-run markMerged case | ~120 | 60 |
| **Total** | | | **~100** |

Band: **amazing** (< 500). Single PR.

## Goal

Two correctness edges from the PR #141 (status-rollup) review, both in `judgment.ts`, tracked instead of burning a review cycle.

## Behavior / fix

1. **Hold `awaiting_judgment` for `dispatching` (ambiguity) streams.** `resumeAfterDecision` / `hasUndecidedFailedStreams` only counts remaining `failed` streams, but `awaiting_judgment` also covers dispatch-ambiguity (`dispatching` streams). Deciding one stream can flip the run to `running` while a `dispatching` stream still needs a decision — back-to-back decides break until a re-tick. (2-bot agreement: Copilot `judgment.ts:107` + Claude.) Fix: broaden the hold predicate to count any undecided stream that should keep the run in `awaiting_judgment`, including dispatch ambiguity.
2. **Guard `markMerged` against terminal runs.** The unconditional flip-to-`done` (when `everyStreamTerminalDoneOrSkipped`) can overwrite a `cancelled` run's sticky status when merge facts are recorded for a landed stream of a cancelled run. (Codex P2, `judgment.ts:397`.) Fix: guard the transition on the run not already being terminal, or reject `markMerged` for terminal runs.

Optional nits, fold in only if cheap: rename `hasUndecidedFailedStreams` → `hasRemainingFailedStreams`; reuse `isStreamDoneOrSkipped` in `everyStreamTerminalDoneOrSkipped`; cover `completedAt` when `mergedAt` absent.

## Acceptance

- Test: multi-failure run with one `failed` + one `dispatching` stream — deciding the `failed` stream (incl. an `adopt` decision) leaves the run in `awaiting_judgment`; deciding the `dispatching` stream releases it.
- Test: `markMerged` on a `cancelled` run does not rewrite the run status to `done`.
- Existing judgment tests unchanged; `make check` green.

## Non-goals

- Any new decision verbs or escalation behavior — this is predicate/guard tightening only.

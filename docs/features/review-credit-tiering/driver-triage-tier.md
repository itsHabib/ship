**Status**: draft
**Owner**: @michael
**Date**: 2026-07-22
**Related**: dossier task `driver-triage-tier` (id: `tsk_01KY4Z6WWBN42B53Y1XDPPYY3Z`), workbench `docs/review-credit-strategy.md` Phase 0.1

# Driver classifies each stream's PR via triage-floor — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/triage.ts` (new), `engine.ts`, `types.ts`, `render.ts`, `tier-map.ts`, store schema | ~250 | 250 |
| Tests | `triage.test.ts` (new), engine test additions | ~250 | 125 |
| **Total** | | | **~375** |

Band: **ideal** per repo's PR sizing convention.

## Goal

The driver consumes review findings but never classifies risk — every stream gets the same review treatment. The validated classifier exists as a name-stable binary on PATH (`triage-floor`: stdin = unified diff, stdout tier line, exit 0 = classified / 1 = operational failure) and nothing calls it. Wire it in as mechanism only: the driver *carries* the tier; policy (skill/CLAUDE.md prose) acts on it later.

## Behavior / fix

When the engine first observes a stream's PR (PR URL becomes known during poll/land), shell out `gh pr diff <N> -R <repo> | triage-floor`, parse the `T0–T3` tier, and persist it on the driver stream.

- **Tier binds to the head SHA, not the PR.** Classify once per head; re-classify whenever the head moves before land (fix commits from later review cycles can change the diff's risk class — a T1 PR that grows a gate-machinery fix must re-tier).
- **Classifier failure is its own state, never a fabricated tier.** Missing binary, exit 1, timeout, or unparseable output persists `tier_source: "classifier_error"` with NO tier and a logged warning; a classified head persists `tier_source: "classified"`. A failure head is treated as the full-panel posture — strictly stronger than any tier's route. Never default to a routable tier (not T0/T1, and not T2 either: a broken classifier must not silently take any weakened route, and downstream spend data must be able to exclude failure cycles).
- Persist tier + tier_source + classified head on the stream record (store column) so resume/status keep them; surface in `render.ts` / status output (e.g. `tier=T1` on the stream row) so `/work-driver` policy can read it without re-running the classifier.
- Reconcile with the existing `tier-map.ts` naming so "tier" is one concept, not two.
- Mechanism only: this PR does NOT change which reviewers get requested.

## Acceptance

A driver run records a tier (+ `tier_source: classified`) on every stream with a PR; moving the head re-classifies; killing `triage-floor` (rename it off PATH in a test) yields `tier_source: classifier_error` with no tier + a warning — not a crash, not a routable tier. `driver status`/render shows the tier.

## Test plan

Unit tests: parse happy path; exit-1 / garbage output / missing binary → `classifier_error` (no tier); re-classify on head move. Engine test threading tier through poll→land. Existing driver suite green (`pnpm test` in packages/driver).

## Non-goals

Reviewer-request behavior changes, `triage-advisory` (stays hand-run via /pr-risk), the spend log (`review-spend-log`, which depends on this landing first), the `-repo` path-override flag (workbench-side task).

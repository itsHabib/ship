**Status**: ready
**Owner**: @michael
**Date**: 2026-07-10
**Related**: `review-findings-v1.md` (design, PR #185); implementation PR #186

# ReviewFindingsV1 follow-ups — stale-head re-validation at attempt start

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---:|---:|
| Production | `packages/driver/src/engine.ts` (attempt-start re-validation), `packages/driver/src/judgment.ts` if the recovery seam lives there | ~60 | 60 |
| Tests | engine address dispatch/recovery tests, fake gh port head mutation | ~120 | 60 |
| Docs | `review-findings-v1.md` corrections | ~15 | 0 |
| **Total** | | | **~120** |

## Functional

PR #186 validates `artifact.subject.head_sha` against the live `headRefOid` only
inside `driver address` validation, before consumption. Once consumption commits,
the prepared address attempt is dispatched — or re-dispatched by dispatch recovery
after a crash, or by `decide retry` after a failed start — with no head re-check.
The window between validation and (re-)dispatch is unbounded: a crash plus an
overnight recovery dispatches an agent against findings whose file/line anchors
describe a superseded tree. That is the "stale review text becomes authoritative"
failure the design exists to prevent.

Requirements:

1. Before starting any address-cycle attempt (fresh dispatch, dispatch-recovery
   re-dispatch, and `decide retry` re-dispatch), re-fetch the PR view and require
   live `headRefOid` to equal the consumed artifact's `head_sha` (the
   `driver_review_artifacts` row for that stream and cycle identifies the consumed
   head). Case-insensitive compare, consistent with the validation path.
2. On mismatch: do not dispatch. Park the stream for judgment through the existing
   park machinery with a legible reason naming both SHAs. A later `decide retry`
   re-runs the same check — no path may bypass it.
3. Non-address attempts are untouched: the check applies only when the attempt
   being started belongs to an address cycle with a consumed artifact row.
4. Doc corrections in `docs/features/ccp-loop-closure/phases/review-findings-v1.md`:
   - `AddressErrorCode` → `AddressRefusalCode` (the real exported type in
     `packages/driver/src/errors.ts`);
   - state that the 1 MiB input cap is enforced at the file-read boundary and maps
     to `findings-unreadable`; remove the cap from the parser-rules list so the
     size check is specified exactly once;
   - restore the conventional phase-doc section headers (`## Tradeoffs`, `## EDs`,
     `## Validation`) per the repo CLAUDE.md phase-doc convention, preserving the
     existing content (the current `Contract decisions` items become EDs).

## Tradeoffs

- One extra `gh view` call per address dispatch/re-dispatch, versus dispatching an
  agent against a stale tree. The call is already paid on the validation path;
  paying it again at attempt start is negligible.
- Alternative considered: pin the dispatched agent's checkout to the consumed
  `head_sha`. Rejected — the agent must work on the live branch head to push
  fixes; a detached pinned checkout can't complete the address flow.
- Parking (not refusing) on mismatch: consumption has already committed, so the
  refusal taxonomy doesn't apply. Parking hands the decision to `driver decide`,
  where the operator can skip the cycle or re-run the panel against the new head.

## EDs

1. **The check lives where an attempt starts, not in a second validation pass.**
   All three dispatch entry points (fresh, recovery, retry) converge on starting
   the prepared attempt; guarding that seam covers every path without duplicating
   validation.
2. **Mismatch is a park, not a terminal failure.** The stream stays decide-able;
   a moved head is an expected race, not a defect.

## Validation

- Engine test: consumed artifact + prepared attempt, fake gh port head advanced →
  attempt start parks with the stale-head reason and performs no dispatch.
- Engine test: same setup, head unchanged → dispatches exactly as today.
- Recovery test: crash-before-start simulation with a moved head → recovery parks
  instead of re-dispatching; with an unmoved head → recovery re-dispatches.
- `decide retry` after a stale-head park with the head still moved → parks again.
- Existing `driver address` state/refusal suite stays green. `make check` passes
  on Windows and Ubuntu.

## Risks

- The fake gh port must allow mutating `headRefOid` between calls; it already
  supports per-call configuration — extend, don't fork.
- Recovery currently dispatches without a gh port dependency in some paths; if
  threading the port in is invasive, confine the check to a small helper the
  recovery tick calls with the port it already has.

## Out of scope

- Semantic dedupe of regenerated same-head artifacts (accepted in the design).
- Producer skills, MCP `driver_address` parity, Gate consumption of
  `panel.missing` — tracked elsewhere.

## Implementation plan

1. Attempt-start guard: resolve the consumed head for the prepared address
   attempt, re-validate against live `headRefOid`, park on mismatch; wire the
   fresh, recovery, and retry paths through it.
2. Tests per Validation, including the fake gh port head mutation.
3. Doc corrections in `review-findings-v1.md`.

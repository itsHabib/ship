**Status**: draft
**Owner**: @michael
**Date**: 2026-07-12
**Related**: dossier task `review-findings-v1-impl` (id: `tsk_01KX76CFTCQ0TPH780MWGHKZVY`, re-scoped 2026-07-10 to residual); parent design `docs/features/ccp-loop-closure/phases/review-findings-v1.md` (PR #185); core implementation merged as PR #186. The original followups contract lived on the stream branch (`.../phases/review-findings-v1-followups.md`) — this spec restates it on main.

# ReviewFindingsV1 residual — stale-head re-validation + doc corrections — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | driver address-attempt start path (re-validation guard) | ~60 | 60 |
| Tests | recovery/retry re-dispatch with moved head parks, matching head proceeds | ~120 | 60 |
| Docs | `docs/features/ccp-loop-closure/phases/review-findings-v1.md` corrections | ~20 | 10 |
| **Total** | | | **~130** |

Band: **amazing** (< 500). Single PR.

## Goal

PR #186 landed parser/migration/store/headRefOid/engine/CLI. Residual scope only:

## Behavior / fix

1. **Stale-head re-validation at attempt start.** #186 checks `head_sha == headRefOid` only inside address validation. A prepared address attempt re-dispatched by crash recovery (or `decide retry`) starts with **no re-check** — an unbounded stale-findings window. Fix: re-verify live `headRefOid` against the consumed artifact's `head_sha` before starting **any** address-cycle attempt; on mismatch, park for judgment — never dispatch.
2. **Doc corrections in `review-findings-v1.md`:** `AddressErrorCode` → `AddressRefusalCode`; pin the 1 MiB cap to the file-read boundary (`findings-unreadable`); restore conventional `Tradeoffs`/`EDs`/`Validation` headers per repo CLAUDE.md.

## Acceptance

- Test: a prepared address attempt whose PR head moved since the findings artifact was written is parked (not dispatched) when started via crash recovery or `decide retry`.
- Test: matching head proceeds unchanged.
- Doc renders with corrected names/headers; no behavior described that the code doesn't have.
- `make check` green.

## Non-goals

- Any change to the findings parser, store schema, or address-cycle semantics landed in #186.

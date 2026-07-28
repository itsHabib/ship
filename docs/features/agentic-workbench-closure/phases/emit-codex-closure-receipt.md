**Status**: implemented
**Owner**: @itsHabib
**Date**: 2026-07-28
**Related**: Workbench PR #160; Dossier `tsk_01KYMQHPWFTNASQ68N7PDYSB9F`

# Emit Codex closure receipt facts

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---:|---:|
| Production | ReviewFindings parser, driver-state emission, address/land handoff, CLI/MCP | ~230 | 230 |
| Tests | parser, emitter sequence, refusal and land guards | ~180 | 90 |
| Docs | this phase record | ~70 | 0 |
| **Total** | | | **~320** |

## Functional

Ship adopts Workbench's additive closure-receipt vocabulary without adding a
receipt database. The existing driver-state JSONL ledger remains authoritative.

At `driver address`, Ship validates the optional
`producer.catalog_revision`, commits the existing artifact-consumption and
dispatch preparation transaction, then emits:

- the opening PR number and exact reviewed head;
- producer, catalog, artifact id/digest/head, Ship run, task, and execution
  facts that Ship already knows;
- the existing review-cycle event.

Legacy V1 artifacts may omit `catalog_revision`; they still dispatch, while the
Workbench reducer reports `catalog_revision` missing and keeps the receipt
incomplete. A present malformed value refuses before consumption.

After address changes the branch, the seat hands the independently reviewed
exact head and Gate run to Ship at land:

```text
ship driver land <drv_id> --pr <n> --stream <ds_id> \
  --reviewed-head <40-lowercase-hex> --gate-run <run_lower-hex>
```

The equivalent `driver_land` MCP fields are `reviewedHeadSha` and
`gateRunRef`. They are optional only for legacy callers and must be supplied
together. Ship verifies the reviewed head equals GitHub's live PR head before
any merge write. GitHub's merge readback supplies the authoritative merged
head. Replayed address and land calls reuse deterministic event identities, so
they cannot duplicate consumption or terminal closure.

## Tradeoffs

- Gate remains the authorization boundary. Ship records the explicit Gate
  reference and exact head but does not infer or recreate Gate's verdict.
- Closure facts are additive driver-state events rather than columns in Ship's
  SQLite store. This keeps the existing artifact/store transaction intact and
  avoids a second source of receipt truth.
- A legacy land call remains supported, but its receipt is visibly incomplete
  because no Gate/final-reviewed join was supplied.

## EDs

1. **Producer provenance crosses the existing transactional seam.** The parsed
   producer fields travel in `ConsumeReviewArtifactInput`; the store transaction
   remains the at-most-once winner, and emission occurs only after it commits.
2. **Opening-head emission waits for address.** PR landing alone does not know
   an exact head. Emitting a placeholder would make the immutable PR event
   unusable for the receipt join, so address supplies the first exact value.
3. **Gate handoff is explicit and paired.** `reviewedHeadSha` and `gateRunRef`
   are accepted together or refused. The live-head check runs before merge.
4. **Refusals never become clean evidence.** Malformed, mismatched, and stale
   address inputs emit a typed `mechanism-repair` intervention when the ledger
   can record it; they emit no closure completion or merge event.

## Validation

- Parser examples cover valid catalog commit/digest forms, legacy omission, and
  malformed/present refusal.
- Emitter sequence covers address → new reviewed head → Gate handoff → merged
  head, including deterministic duplicate address/land behavior.
- Refusal examples cover stale head, malformed artifact, incomplete legacy
  provenance, and paired exact-head Gate handoff.
- `make check`.

## Risks

- Driver-state emission is intentionally best-effort. A filesystem failure is
  warned and leaves the receipt incomplete; it never rewrites Ship's workflow
  outcome.
- A Gate reference is syntactically validated here. Its authorization semantics
  remain Gate-owned and are not duplicated in Ship.

## Out of scope

Native Codex skill implementation, panel adjudication, receipt analytics, a new
receipt store, and any Claude-specific lifecycle behavior.

## Implementation plan

1. Adopt optional catalog provenance in the parser and address transport.
2. Emit address, refusal, Gate-handoff, and merge facts through driver-state.
3. Add CLI/MCP handoff fields and exact-head refusal.
4. Add focused tests and run the full repository check.

**Status**: draft
**Owner**: @michael
**Date**: 2026-07-13
**Related**: dossier task `emit-park-receipts` (id: `tsk_01KXDYHV5Y3EP1C9Z3WKJ1ADKJ`, ship project); serves workbench `talk-readiness` phase (`phs_01KXDYEW3PD7XP7XGX4QVNHWEQ`) — the push-on-block gap. Consumer: workbench `flare-lift-park-receipts` (`tsk_01KXDYH4X6KVWJ7357ZBSNGAK1`).

# Emit a park receipt to receipts.jsonl at awaiting_judgment — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/receipt/src/schema.ts` (outcome enum), `packages/driver/src/engine.ts` (emit at the awaiting_judgment transition) + the receipt-build wiring | ~60 | 60 |
| Tests | `packages/driver/src/engine.test.ts` (transition + idempotency), `packages/receipt/src/*.test.ts` | ~80 | 40 |
| **Total** | | | **~100** |

Band: **amazing** — small, upsert-only, pinned by a transition test.

## Goal

Flare's FOLLOWUPS ask #1: driver `awaiting_judgment` transitions live only in ship's
SQLite, which a sink must not read — so the most operator-relevant event the engine
produces ("I parked and need your judgment") generates no artifact any notifier can see.
Flare tails `receipts.jsonl` and today only lifts `failed`/`cancelled`. Close the
emission gap: at the transition into `awaiting_judgment`, write one park receipt to
`receipts.jsonl`, same envelope as the failed/cancelled receipts, so flare (its own task)
can lift it as a page-worthy event. This is an emission gap on ship's side, not a flare gap.

## Behavior / fix

- **Outcome string — pinned to `parked`.** Add `"parked"` to `receiptOutcomeSchema`
  (`packages/receipt/src/schema.ts`) as an additive enum value. **No
  `RECEIPT_SCHEMA_VERSION` change** — it is a new outcome value on the same schema
  version, and flare's parser has a non-dropping catch-all (it adds `"parked"` on its own
  side, a separate task). Do **not** reuse `"pending"` (that is a not-yet-run stream, not
  page-worthy) and do **not** invent `"awaiting_judgment"` as an outcome value (keep
  outcome strings short and parallel to `failed`/`cancelled`). **The chosen string
  `parked` is load-bearing: record it verbatim in this PR's body — `flare-lift-park-receipts`
  matches it exactly.**
- **Emit at the transition into `awaiting_judgment`.** In the driver engine
  (`packages/driver/src/engine.ts` — the `finalizeExit` branch that commits the
  `awaiting_judgment` status, the single commit point for that transition, alongside the
  existing `writeAndDeliverEscalations`), construct a park `Receipt` and persist it through
  the **existing** receipt path (`buildReceipt` → `upsertReceipts` → `writeReceiptsFile`
  from `packages/receipt/src`). Reuse the same envelope/context fields the failed/cancelled
  receipts already carry (source `"driver"`, `repo`, `run_id`/stream id, `task_id`/`task_slug`,
  etc.). Do not fork the writer, change the whole-line/upsert mechanism, or touch any
  producer lock. If `receipts.jsonl` is currently produced by a projection over
  manifest/run state (`manifest.ts` / `runs.ts`) rather than written by the engine at
  transition time, wire the park emission at the transition using that same writer path so
  flare's live tail observes the park promptly — the binding acceptance is a `parked`
  receipt in `receipts.jsonl` at the park, idempotently.
- **Idempotent across re-polls.** `evaluateExit` returns `awaiting_judgment` on every tick
  while a stream stays failed/ambiguous, so the `finalizeExit` branch runs repeatedly. Key
  the park receipt so re-polling the same parked run **upserts** (does not append a
  duplicate) — reuse the existing `${source}:${key}` identity + `upsertReceipts`. Exactly
  one park receipt per park.
- Leave the `failed`/`cancelled`/`succeeded`/`merged` projection paths (`manifest.ts`,
  `runs.ts`) unchanged; the park receipt is parallel telemetry, alongside the existing
  parked-stream escalation flow.

## Acceptance

- A driver run entering `awaiting_judgment` writes exactly one park receipt with
  `outcome: "parked"`; re-polling the same parked run does not add a second (idempotent via
  upsert-by-identity).
- The receipt validates against `receiptSchema` (stable `key` + `outcome: "parked"` + the
  JSON object per line) and carries the same context fields as the failed/cancelled receipts
  (source, repo, run/stream id).
- `failed` / `cancelled` / `succeeded` / `merged` receipt behavior is unchanged; existing
  receipts tests stay green.
- The chosen outcome string (`parked`) is recorded verbatim in the PR body for
  `flare-lift-park-receipts`.

## Test plan

- `packages/driver`: a state-machine test driving a run to `awaiting_judgment` and asserting
  exactly one written park receipt with `outcome: "parked"`; an idempotency test that
  re-ticks the parked run and asserts no duplicate row.
- `packages/receipt`: extend the schema / round-trip tests to cover the `"parked"` outcome;
  existing failed/cancelled tests stay green.
- `pnpm test --run packages/receipt packages/driver`; repo `make check` / lint green.

## Non-goals

- Flare's lifting / routing / severity (workbench `flare-lift-park-receipts`).
- Emitting receipts for other transitions (`blocked_on_merges`, address re-dispatch, etc.)
  — only `awaiting_judgment`.
- Reading anything back from `receipts.jsonl`; changing dedupe/throttle; changing the
  producer lock or the whole-file write mechanism.
- Any `RECEIPT_SCHEMA_VERSION` bump.

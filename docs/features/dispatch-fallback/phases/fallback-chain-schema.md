# P1 — fallback chain schema

**Status:** in progress
**Owner:** @itsHabib
**Date:** 2026-07-13
**Spec:** [`../spec.md`](../spec.md) §5–§7.1 (data model, API contract, import flow)

## Scope

Weighted-LOC budget: ~350–500 (spec §9 P1 row). Schema only — the chain is
declared, validated, stored, and made visible. **No engine hop/dispatch
behavior** (that is P2a), and **no `targetModelId` dispatch plumbing / transient
retry** (P2b).

## Functional

1. A manifest stream may declare `fallback: [{ runtime, provider, model_id? }, …]`;
   a run may declare `default_fallback` inherited by streams that omit `fallback`
   (mirrors `default_runtime` / `default_provider`). Effective chain =
   `stream.fallback ?? default_fallback ?? []`.
2. Import freezes the resolved chain onto the stream row: `fallbackChain` (JSON,
   frozen), `fallbackCursor` (0), `fallbackLog` (empty, append-only). `model_id`
   rides inside each chain entry's JSON (`modelId`), not a new column.
3. `reviewCycles` is initialized to `0` at import (spec §4.3 — the pre-work gate
   reads `(reviewCycles ?? 0) === 0`; freshly imported streams must read 0).
4. Import validates each chain target (structured import failure, same channel as
   the existing provider preflight): a wired `selectRunner` cell, not `rooms`, not
   a dupe of the primary or an earlier entry, and the **same per-cell structural
   requirements primaries enforce** — `branch_name` for `(local, *)` and
   `(cloud, claude)`, `repo_url` for `(cloud, *)` — derived from `assign.ts`'s
   cell checks, not restated.
5. If a chain target's per-cell env credential (§4.4 table) is absent, import
   records a run-level **warning** (advisory; import still succeeds).
6. `driver status` gains a fallback diagnostic formatter (hops/skips/retries),
   and the render overlay reflects the stream's **current** runtime/provider so a
   (future) hopped stream never renders as its original target.
7. Streams with no chain are byte-for-byte as today (opt-in); the columns stay
   null.

## Engineering decisions

- **ED-1 — package boundary.** `@ship/store` cannot import `@ship/driver`
  (driver → store). The store owns the persistence schema (`fallbackChainTarget`,
  `fallbackLogRecord`); it is structurally the shared `DispatchTarget` vocabulary
  (viability.ts) with `model_id` optional per §4.1. Import maps the manifest
  entry's `model_id` → the store's `modelId` on freeze.
- **ED-2 — derive, not restate.** The wired-cell matrix + per-cell structural
  requirements move into a focused `dispatch-cell.ts`; `assign.ts` (model-lottery)
  and the new chain validation both consume it. `isLegalCell` stays exported.
- **ED-3 — reviewCycles at the import layer only.** The store insert stays
  default-null; import sets 0. Store-level inserts (and their tests) are
  unaffected.
- **ED-4 — env warning is a sync presence check.** Import-time is advisory
  (§4.4), so it checks credential presence per the table — not the async
  catalog viability `checkTargetViability` does at hop time.

## Validation

- manifest: `fallback` / `default_fallback` parse, inheritance, unknown-key warns,
  malformed-enum hard-errors.
- import: chain freezes with cursor 0 + empty log; reviewCycles 0; each rejection
  case (rooms / unwired / dupe / missing branch / missing repo_url) yields a
  structured error; env-absent yields a warning; no-chain stream leaves columns
  null.
- store: chain/cursor/log round-trip through insert → read and survive close/reopen.
- render: a stream renders its store runtime/provider; determinism preserved.
- status-mapping: formatter renders hop/skip/retry records; undefined when empty.
- migrations: `0019` applies; new columns present; count updated.

## Out of scope

Engine hop transition, no-work-products gate, viability walk, `FALLBACK_RESET_PATCH`,
transient retry, `targetModelId` dispatch honoring, escalation copy — all P2a/P2b.

**Status**: draft
**Owner**: @michael
**Date**: 2026-06-01
**Related**: dossier task `ship-store-write-contention` (id: `tsk_01KT1R0B92J5P0QXTCWN6K6J4W`); **depends on** `surface-failed-run-diagnostics` (id: `tsk_01KT1QZW3XPNF0FDYMQZAAZAAP`) — merge that first.

# Concurrent local ship runs hit SQLite "database is locked"

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/store/src/db.ts` (PRAGMAs: `busy_timeout`, WAL verification), error classification so a lock surfaces as a clear contention error | ~60 | 60 |
| Tests | `packages/store/src/db.test.ts` (or a store concurrency test) | ~80 | 40 |
| Docs | safe local-parallelism note (0×) | ~10 | 0 |
| **Total** | | | **~100** |

Band: **amazing** (< 500).

## Goal

Running three local ship streams concurrently (2 ship-hardening + 1 dossier) on 2026-06-01, all three failed at the same wall-clock second (`01:51:58`). The dossier run's `errorMessage` was literally `database is locked`; the two ship runs surfaced as opaque SDK `ERROR` (see `surface-failed-run-diagnostics`). Both ship runs had run ~27 min (near the 30-min cap) with real edits on disk — consistent with stalling on a contended write, not a logic failure. The same-second triple failure points at a shared resource, not three independent faults.

## Hypothesis

SQLite single-writer lock contention. Either (a) ship's own store (`packages/store`, the `cursor_runs`/`workflow_runs` event-pump writes) under N concurrent ship processes against the same DB file, and/or (b) the Cursor SDK's local agent store (`sqlite3` transitive dep) contended across concurrent local agents.

## Behavior / fix

1. **Confirm the locking layer** — ship-store vs SDK-store. Check whether each ship process opens its own DB or a shared one; check the `busy_timeout` PRAGMA (`db.ts` sets PRAGMAs).
2. **If ship-store:** set/raise `PRAGMA busy_timeout` and ensure WAL mode (concurrent readers + single writer with backoff) so transient contention retries instead of erroring. `db.ts` already warns if WAL isn't honored — verify WAL is actually on for file-backed DBs under concurrency (the warning path may be firing silently).
3. **If SDK-store** (outside ship's control): document a concurrency cap (serialize local runs, or cap parallelism) and surface a clear `local run contention — reduce parallelism` error rather than an opaque ERROR. This error path **depends on** `surface-failed-run-diagnostics` landing first.
4. **Decide a supported local-parallelism level** and either enforce or document it. Cloud runs don't share a local DB, so this is local-runtime-specific.

## Acceptance

- N concurrent local runs (N ≥ 3) either all succeed, or any that can't surface a clear contention error (not an opaque ERROR — depends on `surface-failed-run-diagnostics`).
- A documented or enforced safe local-parallelism level.

## Test plan

- Store-level test: open N connections against one file-backed DB, confirm WAL is on and `busy_timeout` is set to the chosen value; concurrent writes back off + retry instead of throwing within the timeout window.
- If a contention error class is added: unit test that a SQLite `SQLITE_BUSY` / `database is locked` maps to the clear contention message.

## Repro

`wf_01KT0CGPW7TXN6MZXRSQYGF50B`, `wf_01KT0CH4829MWNM14TEWCSRNJ5` (ship), `wf_01KT0CJ403NEQN9A49BX1AR85V` (dossier, explicit `database is locked`). Events under `~/AppData/Roaming/ship/runs/<id>/events.ndjson`.

## Non-goals

- The diagnostics surface itself (sibling task, upstream of this one).
- Cloud-runtime contention — cloud runs don't share a local SQLite store; this is local-only.

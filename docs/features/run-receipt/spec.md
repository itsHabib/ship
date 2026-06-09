# Run receipt — design spec

## Problem

The workbench is **unfalsifiable**. Three weeks of friction-logged dogfooding
prove the loop _runs_, but there is no dataset that answers whether it _works_:
success rate, human-override rate, review cycles, time-to-merge, which reviewer
was right, cost. The data exists but is smeared across four artifacts that are
never joined — ship run dirs, work-driver manifests, review-coordinator
verdicts, dossier task notes.

A **run receipt** is one row per unit of agent work: the join of those sources
into an append-safe, queryable JSONL dataset. It is the substrate every later
evaluation bet (reviewer calibration, `sense`-scored verdict quality, the
self-improving loop) sits on.

## Non-goals (v0)

- **No cross-MCP discovery.** This package does not find which manifest / dossier
  task / coordinator verdict belongs to a run, nor fetch GitHub, nor open the
  store. That join is a _skill's_ job (policy/mechanism split — "skills compose,
  MCPs don't"). v0 is pure mechanism over inputs it is handed.
- **No new MCP verb.** Receipts are a reporting/telemetry join; per the workbench
  invariant, cross-cutting joins live in skills + a tested helper, not in ship's
  MCP surface.
- **No LLM.** Deterministic file munging. A metrics ledger hand-assembled by an
  agent each run would drift; that is precisely why this is code, not prose.

## Approach (v0)

`@ship/receipt` — a pure DI core with thin IO adapters, in ship's monorepo
because ship already persists run state ("persist what happened" growing
inward) and carries the mature test/lint/CI harness.

Two structured sources, emitted with a `source` discriminator and a stable
`${source}:${key}` identity:

- `driver` ← work-driver manifest streams (loop outcome: PR, merge, cycles, runtime).
- `ship-run` ← ship `result.json` (execution: status, duration, model).

The report layer segments metrics by source so none silently averages a column
one source never fills. Persistence is idempotent JSONL upsert.

```
manifestToReceipts(text) ─┐
                          ├─► upsertReceipts(existing, incoming) ─► receipts.jsonl ─► report()
loadShipRunReceipts(dir) ─┘
```

## Data model

`receiptSchema` (zod, `RECEIPT_SCHEMA_VERSION = 1`). Required: `schema_version`,
`key`, `source`, `outcome`. Everything else optional (sources fill different
columns). Reads validate every row so a stale-schema line fails loudly.

## Rollout

- **Phase 1 (this PR):** the package — schema, two adapters, join, JSONL,
  report, CLI, tests. Backfills a dataset from every historical `driver.md` +
  the local ship runs.
- **Phase 2:** the discovery skill (`/run-receipt`) — walk manifests, resolve the
  ship run per stream via store `doc_path ↔ spec_path`, enrich, append.
- **Phase 3:** reviewer-accuracy labelling (fixed / ignored / FP / dup /
  caught-by-CI / caught-by-human) — makes "judge over reviewers" defensible.
- **Phase 4:** auto-append-on-merge (a work-driver step / hook) so the dataset
  accrues structurally, not by remembering.

## Open questions

- `driver ↔ ship-run` stitch key: `doc_path`(store) vs `spec_path`(manifest) tail
  match, or branch? Resolve in Phase 2 against real data.
- Token/$ cost: parse `events.ndjson` usage vs a cursor API call. Deferred.

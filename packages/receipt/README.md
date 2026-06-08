# `@ship/receipt`

## What this package owns

The workbench **run-receipt** layer: one queryable row per unit of agent work,
joined from the structured artifacts the loop already emits, persisted as an
append-safe JSONL dataset, and reduced to headline metrics.

A receipt answers the questions the friction log only ever answered as
anecdote — _success rate, merge rate, review cycles, duration_ — as data you
can query, chart, and put in front of a skeptic.

## Sources (today)

| Source | Artifact | Columns it fills |
| --- | --- | --- |
| `driver` | a work-driver `driver.md` manifest stream | outcome, PR, merge commit, review cycles, runtime, task linkage, merged-at |
| `ship-run` | a ship `<runs-dir>/<runId>/result.json` | terminal status, duration, model, PR (cloud) |

Most receipt fields are optional because the two sources fill different
columns; the report layer **segments by `source`** so a metric never silently
averages a column one source never fills.

## Public surface

- **Adapters** — `manifestToReceipts(text)`, `loadShipRunReceipts(runsDir)` / `runResultToReceipt(input)`, `resolveDefaultRunsDir(env, platform, home)`
- **Join** — `upsertReceipts(existing, incoming)` (idempotent by `${source}:${key}`), `sortReceipts`
- **Persistence** — `readReceiptsFile` / `writeReceiptsFile`, `parseReceiptsJsonl` / `serializeReceiptsJsonl`
- **Query** — `report(receipts)` → `ReportSummary`, `formatReport(summary)`
- **Contract** — `receiptSchema`, `Receipt`, `RECEIPT_SCHEMA_VERSION`, `buildReceipt`

## CLI

```bash
# Backfill the dataset from every driver.md under a tree + the local ship runs.
ship-receipt build --manifests-dir ../dossier/docs/features --out receipts.jsonl

# Query it.
ship-receipt report --in receipts.jsonl
```

`build` is idempotent: it upserts into the existing JSONL, so re-running over the
same artifacts never duplicates a row.

## Boundaries (deferred — see `docs/features/run-receipt/spec.md`)

This package is pure mechanism over inputs it is handed. It does **not** discover
which manifest / dossier task / review-coordinator verdict belongs to a run, fetch
GitHub, or open the store — that cross-MCP join is the caller's (a skill's) job.
The precise `driver ↔ ship-run` stitch (via store `doc_path`), reviewer-accuracy
labelling, token cost, and auto-append-on-merge are the next bricks.

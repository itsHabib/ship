**Status**: draft
**Owner**: @itsHabib
**Date**: 2026-07-12
**Related**: dossier task `control-room-workflow-observability-contract` (id: `tsk_01KXCYSQ6BACMN4E8PY6XJ8PQW`); Workbench Portfolio Control Room TDD

# Enrich Ship workflow read contracts for Portfolio Control Room

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---:|---:|
| Production source | owner schemas/projections in `packages/workflow`, `packages/core`, and `packages/store`; `packages/cli/src/commands/{list,status}.ts`; `packages/cli/src/format.ts`; MCP output schema only where it is the existing shared owner type | ~350 | ~350 |
| Tests and fixtures | local/cloud/rooms workflow fixtures; CLI list/status, schema, formatter, and backward-compatibility tests | ~300 | ~150 |
| **Total** | | **~650** | **~500** |

Band: **ideal** per the repository PR-sizing convention.

## Functional

Extend the existing `ship list --json` and `ship status <workflowRunId> --json` owner contracts with one stable additive observability view across local, cloud, and rooms runs. Both commands must agree on normalized fields for requested and actual runtime/provider/model, start/end/duration, failure category and safe detail, and evidence availability with relative owner-issued references.

The list response remains `{ "runs": [...] }`; status remains the hydrated point view. Existing fields and consumers stay compatible. Newly unavailable producer facts must be omitted or represented by a typed availability state—never zero-filled, inferred from requested configuration, or reconstructed by parsing `result.json`, event logs, prompt artifacts, or provider-specific files.

The owner projection must preserve the distinction between requested configuration, dispatched/actual execution facts, and evidence availability. Where a runtime cannot produce a field, expose that absence honestly and consistently in list and detail.

## Tradeoffs

- Normalize at Ship's read seam rather than in Workbench so future consumers share one contract and runtime-specific artifact formats stay private.
- Additive fields may duplicate some nested internal facts. That is preferable to requiring downstream consumers to understand local/cloud/rooms persistence differences.
- Safe evidence references are relative identifiers beneath Ship-owned run storage, not arbitrary absolute paths or proof that telemetry exists.

## EDs

- Define one owner-side observability schema used by both CLI formatters; do not hand-build divergent list and detail payloads.
- Requested runtime/provider/model and actual/dispatched runtime/provider/model are separate optional fields.
- `durationMs` is present only when owner timestamps or a producer-reported duration establish it; never derive a successful-looking zero.
- Failure detail is sanitized for a local UI consumer and must not expose tokens, environment values, usernames, or absolute filesystem paths.
- Evidence uses an explicit availability state and relative references. `available` means Ship can resolve the referenced artifact; `unavailable`/`unknown` carries a typed reason when known.
- Existing JSON keys and MCP schemas remain backward compatible; additions are optional and additive.

## Validation

- Schema/unit tests lock the additive observability view and prove old fixture payloads still parse.
- Representative local, cloud, and rooms fixtures cover requested-versus-actual fields, start/end/duration, failure categories, and evidence available/unavailable/unknown cases.
- `ship list --json` and `ship status <id> --json` return equal observability subviews for the same run.
- Tests prove absent producer telemetry remains absent/typed unknown and is never copied from requested configuration or filled with zero.
- Tests prove no JSON command reads or parses provider result/event artifacts to construct required fields.
- `pnpm check` passes on Windows and Linux CI.

## Risks

- The current `WorkflowRun` schema is a durable domain type used across packages; careless required fields would break old rows and consumers. Keep additions optional and migrate only when persistence truly needs new facts.
- Runtime adapters may name equivalent concepts differently. Normalize meanings, not merely property names, and preserve unknown when equivalence is not proven.
- Safe failure/evidence output can regress into absolute paths through nested structures; include redaction and schema tests.

## Out-of-scope

- Driver-run discovery.
- Dashboard code, statistics, aggregation, ranking, or telemetry invention.
- Tracelens diagnosis or downstream artifact parsing.
- New mutation endpoints or changes to workflow execution behavior.

## Implementation-plan

1. Inventory persisted facts and lock a shared additive observability schema with legacy fixtures.
2. Populate the view for local, cloud, and rooms from owner-known durable state, preserving typed absence.
3. Project the same view through list and status JSON without changing existing keys or text behavior unnecessarily.
4. Add cross-runtime equality, backward-compatibility, redaction, and no-artifact-parsing tests; run focused packages and full `pnpm check`.

**Status**: draft
**Owner**: @itsHabib
**Date**: 2026-07-12
**Related**: dossier task `control-room-workflow-observability-contract` (id: `tsk_01KXCYSQ6BACMN4E8PY6XJ8PQW`); Workbench Portfolio Control Room TDD

# Enrich Ship workflow read contracts for Portfolio Control Room

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---:|---:|
| Production source | a new owner projection in `packages/core`/`packages/mcp`, one batched latest-cursor-run read in `packages/store`, `packages/cli/src/commands/{list,status}.ts`, and `packages/cli/src/format.ts`; persisted `WorkflowRun` stays unchanged | ~420 | ~420 |
| Tests and fixtures | local/cloud/rooms workflow fixtures; CLI list/status, schema, formatter, and backward-compatibility tests | ~300 | ~150 |
| **Total** | | **~720** | **~570** |

Band: **ideal** per the repository PR-sizing convention.

## Functional

Extend the existing `ship list --json` and `ship status <workflowRunId> --json` owner contracts with one stable additive `WorkflowObservabilityView` across local, cloud, and rooms runs. This is a non-persisted owner projection; do not add observability fields to the strict persisted `WorkflowRun` Zod schema. Both commands must agree on normalized fields for requested and actual runtime/provider/model, start/end/duration, failure category and safe detail, and evidence availability with relative owner-issued references.

The list response remains `{ "runs": [...] }`; status remains the hydrated point view. Each run adds the same optional `observability` object produced by one shared projector. Existing fields and consumers stay compatible. Newly unavailable producer facts must be omitted or represented by a typed availability state—never zero-filled, inferred from requested configuration, or reconstructed by parsing `result.json`, event logs, prompt artifacts, or provider-specific files. The legacy point-status diagnostic/branch fields may continue their current artifact-backed behavior, but the new `observability` object never depends on that I/O.

The owner projection must preserve the distinction between requested configuration, dispatched/actual execution facts, and evidence availability. Where a runtime cannot produce a field, expose that absence honestly and consistently in list and detail.

## Tradeoffs

- Normalize at Ship's non-persisted read-projection seam rather than in Workbench so future consumers share one contract and runtime-specific artifact formats stay private.
- Additive fields may duplicate some nested internal facts. That is preferable to requiring downstream consumers to understand local/cloud/rooms persistence differences.
- Safe evidence references are relative identifiers beneath Ship-owned run storage, not arbitrary absolute paths or proof that telemetry exists.
- For list reads, fetch the latest relevant cursor-run facts for the bounded workflow IDs in one batched store query. N+1 `getCursorRun` loops and per-row filesystem reads are prohibited. Point status uses the same projector with a one-ID store read.

## EDs

- Define one owner-side `WorkflowObservabilityView` schema/projector used by both list and status; do not hand-build divergent payloads. `GetWorkflowRunOutput` may gain the optional projection, while persisted `WorkflowRun` remains unchanged.
- Requested runtime/provider/model and actual/dispatched runtime/provider/model are separate optional fields.
- `durationMs` is present only when owner timestamps or a producer-reported duration establish it; never derive a successful-looking zero.
- Failure detail is sanitized for a local UI consumer and must not expose tokens, environment values, usernames, or absolute filesystem paths.
- Evidence uses an explicit availability state and relative references sourced from durable cursor-run artifact metadata. `available` means Ship owns a persisted relative artifact reference; `unavailable`/`unknown` carries a typed reason when known. Exclude `CursorRunRef.artifactsDir` and every absolute path from the public projection.
- Existing JSON keys and MCP schemas remain backward compatible; additions are optional and additive.
- CLI consumers are required to parse permissively and ignore unknown additive fields; the contract does not support downstream strict-object schemas.

## Validation

- Schema/unit tests lock the additive observability view and prove old fixture payloads still parse.
- Representative local, cloud, and rooms fixtures cover requested-versus-actual fields, start/end/duration, failure categories, and evidence available/unavailable/unknown cases.
- `ship list --json` and `ship status <id> --json` return equal observability subviews for the same run.
- Tests prove absent producer telemetry remains absent/typed unknown and is never copied from requested configuration or filled with zero.
- A store spy asserts one bounded batched cursor-run lookup for an N-row list (no N+1). A `ShipFs` stub that throws on every read proves the shared observability projector and list command complete without artifact I/O; point-status comparison isolates the projection before legacy diagnostic enrichment.
- Allowed-key/redaction tests prove `artifactsDir`, absolute paths, usernames, tokens, and environment values never enter the observability object.
- `make check` passes on Windows and Linux CI.

## Risks

- The current `WorkflowRun` schema is a durable strict domain type used across packages; it is explicitly not the extension point. Keep the observability projection optional on public read outputs.
- A new batched store projection is required to avoid N+1 reads. Keep it bounded by the list's maximum 200 workflow IDs and preserve existing contention guards.
- Runtime adapters may name equivalent concepts differently. Normalize meanings, not merely property names, and preserve unknown when equivalence is not proven.
- Safe failure/evidence output can regress into absolute paths through nested structures; include redaction and schema tests.

## Out-of-scope

- Driver-run discovery.
- Dashboard code, statistics, aggregation, ranking, or telemetry invention.
- Tracelens diagnosis or downstream artifact parsing.
- New mutation endpoints or changes to workflow execution behavior.

## Implementation-plan

1. Inventory durable workflow/cursor-run facts and lock a shared optional `WorkflowObservabilityView` with legacy fixtures; leave `WorkflowRun` unchanged.
2. Add one bounded store query for latest cursor-run facts by workflow ID and populate the projection for local, cloud, and rooms with typed absence and no filesystem reads.
3. Attach the same projection to list and status JSON while preserving all existing keys and legacy point-detail enrichment.
4. Add cross-runtime equality, batched-read, permissive-consumer, backward-compatibility, redaction, and throwing-`ShipFs` tests; run focused packages and the full `make check` gate.

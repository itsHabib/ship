**Status**: draft
**Owner**: @itsHabib
**Date**: 2026-07-12
**Related**: dossier task `control-room-driver-list-contract` (id: `tsk_01KXCY4CK4MB41XDFQR35FCKZ5`); Workbench Portfolio Control Room TDD

# Expose read-only driver-run listing for Portfolio Control Room

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---:|---:|
| Production source | `packages/driver/src/service.ts`, `packages/cli/src/commands/driver.ts`, `packages/cli/src/format.ts`; the existing store list is consumed without changing its filter/order contract | ~230 | ~230 |
| Tests and fixtures | driver service/store tests, `packages/cli/test/driver-command.test.ts`, formatter tests, cross-process SQLite harness | ~200 | ~100 |
| **Total** | | **~430** | **~330** |

Band: **amazing** per the repository PR-sizing convention.

## Functional

Add `ship driver list --json` as the single Control Room discovery contract for durable driver work. Workbench invokes the installed Ship CLI as a bounded subprocess and parses stdout JSON; it does not import an npm package or speak MCP for this read. The command must call the existing read-only `DriverService.listDriverRuns()` seam, return a versionable envelope with bounded newest-first runs, and support validated `--repo`, repeatable `--status`, and `--limit` filters. The store's existing `project` and `phase` filters remain internal and are deliberately not exposed by this CLI change. An empty store returns the same envelope with an empty `runs` array.

Each run must expose durable identity and status, repository/project/phase, a safe input-document identity, created/updated timestamps, and nested batch/stream facts already owned by Ship: task/spec identity, requested runtime/provider/model/effort, dispatched provider/model/params where known, workflow and PR links, failure/judgment detail, and review/merge progress. Define a dedicated `DriverListView`; do not serialize `DriverRun` directly and do not reuse `buildDriverStatusView`. The view excludes `sourceJson` and absolute `manifestPath`; it may expose the source hash plus an owner-normalized relative manifest reference when Ship can prove it is safe. Stream `specPath` remains the canonical task-document identity. Preserve omission for facts Ship does not know. JSON consumers must tolerate additive fields; the command must not manufacture source-derived staleness or dashboard policy.

Text mode should remain useful to an operator without becoming a second semantic contract. `ship driver status <id> --json` must remain backward compatible.

## Tradeoffs

- Prefer the existing driver service/store projection over a duplicate query or direct SQLite access.
- Do not add `list_driver_runs` to MCP in this change. The Control Room consumer uses the CLI contract, and no second current consumer justifies another owner surface.
- Return durable nested data even if the payload is wider than a summary-only list. The default/maximum limit bounds cost, and Control Room must not invoke one status subprocess per row.
- The subprocess JSON envelope is the owner seam. `stderr` is diagnostic-only, stdout contains exactly one JSON document, and nonzero exit means the source is unavailable/degraded to Workbench.

## EDs

- The list operation is observational: no import, tick, lease acquisition, orphan sweep, dispatch, write, or timestamp update.
- Ordering follows the authoritative existing store contract: `createdAt` descending, then stable driver-run ID descending for deterministic ties.
- Limits are positive integers with an owner-defined cap consistent with Ship's other list surfaces; invalid status/filter/limit values fail before opening a write transaction.
- Requested and actual/dispatched fields remain distinct. Unknown actual telemetry is omitted rather than copied from requested values.
- `sourceJson`, absolute `manifestPath`, and any other internal absolute paths are excluded. A public manifest reference is relative and optional; stream `specPath` is owner-issued and consumers must not parse the manifest file.

## Validation

- Service tests cover empty, populated, repo/status/limit filtering, deterministic ordering, and nested run/stream facts.
- CLI tests cover JSON envelope, text output, repeated statuses, invalid filters/limits, empty store, and compatibility of point status.
- A two-process SQLite harness writes/imports with one process and lists with another, proving the command reads durable state rather than process-local state.
- A deterministic mutation sentinel reads SQLite `total_changes()` on the same connection immediately before and after service listing and asserts equality; CLI harness spies separately prove no tick/orphan-resume/dispatch call occurs.
- The two-process harness runs on both Windows and Linux CI against a closed writer/open reader sequence, avoiding platform-specific concurrent-WAL assumptions.
- `make check` passes on Windows and Linux CI.

## Risks

- Reusing full nested driver rows can expose `sourceJson` and internal absolute paths. The dedicated list projection and an explicit allowed-key schema are release gates.
- Factory construction must retain the existing guarantee that read verbs do not trigger orphan recovery.
- Store ordering and CLI ordering must not diverge; make the service/store seam authoritative.

## Out-of-scope

- Workflow-run observability enrichment.
- A new MCP list tool.
- CLI `--project` or `--phase` filters; those remain store-internal until a reviewed consumer needs them.
- Dashboard code, ranking, staleness, aggregation, or mutation controls.
- Parsing driver manifests or result artifacts in downstream consumers.

## Implementation-plan

1. Lock the dedicated JSON envelope and allowed-key projection in tests, including unknown/omitted fields and explicit exclusion of `sourceJson`/absolute paths.
2. Reuse the existing store/service list filter and `createdAt DESC, id DESC` order without adding CLI project/phase flags.
3. Register `ship driver list`, validate flags, and add dedicated JSON/text formatters with stdout/stderr framing tests.
4. Add cross-process and no-mutation coverage, then run focused package tests and the full `make check` gate.

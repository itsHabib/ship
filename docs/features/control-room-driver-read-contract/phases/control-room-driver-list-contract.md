**Status**: draft
**Owner**: @itsHabib
**Date**: 2026-07-12
**Related**: dossier task `control-room-driver-list-contract` (id: `tsk_01KXCY4CK4MB41XDFQR35FCKZ5`); Workbench Portfolio Control Room TDD

# Expose read-only driver-run listing for Portfolio Control Room

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---:|---:|
| Production source | `packages/driver/src/service.ts`, `packages/cli/src/commands/driver.ts`, `packages/cli/src/format.ts`; owner-side store schemas only if the existing durable view cannot express the contract | ~250 | ~250 |
| Tests and fixtures | driver service/store tests, `packages/cli/test/driver-command.test.ts`, formatter tests, cross-process SQLite harness | ~200 | ~100 |
| **Total** | | **~450** | **~350** |

Band: **amazing** per the repository PR-sizing convention.

## Functional

Add `ship driver list --json` as the single Control Room discovery contract for durable driver work. It must call the existing read-only `DriverService.listDriverRuns()` seam, return a versionable envelope with bounded newest-first runs, and support validated `--repo`, repeatable `--status`, and `--limit` filters. An empty store returns the same envelope with an empty `runs` array.

Each run must expose durable identity and status, repository/project/phase, manifest/input-document identity, created/updated timestamps, and nested batch/stream facts already owned by Ship: task/spec identity, requested runtime/provider/model/effort, dispatched provider/model/params where known, workflow and PR links, failure/judgment detail, and review/merge progress. Preserve omission for facts Ship does not know. JSON consumers must tolerate additive fields; the command must not manufacture source-derived staleness or dashboard policy.

Text mode should remain useful to an operator without becoming a second semantic contract. `ship driver status <id> --json` must remain backward compatible.

## Tradeoffs

- Prefer the existing driver service/store projection over a duplicate query or direct SQLite access.
- Do not add `list_driver_runs` to MCP in this change. The Control Room consumer uses the CLI contract, and no second current consumer justifies another owner surface.
- Return durable nested data even if the payload is wider than a summary-only list. The default/maximum limit bounds cost, and Control Room must not invoke one status subprocess per row.

## EDs

- The list operation is observational: no import, tick, lease acquisition, orphan sweep, dispatch, write, or timestamp update.
- Ordering is `updatedAt` descending, then stable driver-run ID descending for deterministic ties.
- Limits are positive integers with an owner-defined cap consistent with Ship's other list surfaces; invalid status/filter/limit values fail before opening a write transaction.
- Requested and actual/dispatched fields remain distinct. Unknown actual telemetry is omitted rather than copied from requested values.
- Manifest/spec paths are owner-normalized identities from persisted driver rows; consumers must not parse the manifest file.

## Validation

- Service tests cover empty, populated, repo/status/limit filtering, deterministic ordering, and nested run/stream facts.
- CLI tests cover JSON envelope, text output, repeated statuses, invalid filters/limits, empty store, and compatibility of point status.
- A two-process SQLite harness writes/imports with one process and lists with another, proving the command reads durable state rather than process-local state.
- A mutation sentinel (or before/after database digest/change counter) proves list performs no writes, leases, ticks, orphan resume, or dispatch.
- `pnpm check` passes on Windows and Linux CI.

## Risks

- Reusing full nested driver rows can accidentally expose internal-only absolute paths. Keep the public projection intentional and add schema assertions for every field.
- Factory construction must retain the existing guarantee that read verbs do not trigger orphan recovery.
- Store ordering and CLI ordering must not diverge; make the service/store seam authoritative.

## Out-of-scope

- Workflow-run observability enrichment.
- A new MCP list tool.
- Dashboard code, ranking, staleness, aggregation, or mutation controls.
- Parsing driver manifests or result artifacts in downstream consumers.

## Implementation-plan

1. Lock the JSON envelope and public projection in tests, including unknown/omitted fields.
2. Reuse or minimally extend the existing store/service list filter and deterministic order.
3. Register `ship driver list`, validate flags, and add JSON/text formatters.
4. Add cross-process and no-mutation coverage, then run the focused packages and full `pnpm check`.

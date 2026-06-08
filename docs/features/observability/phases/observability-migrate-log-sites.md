**Status**: draft
**Owner**: @michael
**Date**: 2026-06-02
**Related**: dossier task `observability-migrate-log-sites` (id: `tsk_01KTJH8S28YJPD5KR2MWET0TDH`); locked design [docs/features/observability/spec.md](../spec.md) §1, §8, §9 phase 1(c). **Depends on** `observability-logger-package` + `observability-failure-category-enum`.

# Migrate the ~24 ad-hoc log sites to @ship/logger

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `store/db.ts`, `store/store.ts`, `cursor-runner/*` (debug/cloud-runner/artifacts-capture), `core/service.ts`, `mcp-server/bin.ts` + entrypoint DI wiring | ~150 | 150 |
| Tests | grep-guard + stdout-purity (extend existing e2e) | ~80 | 40 |
| **Total** | | | **~190** |

Band: **amazing** (< 500).

## Goal

Replace the ~24 ad-hoc diagnostic log sites (unstructured strings) with `@ship/logger` structured calls carrying fields — so every diagnostic is queryable and failure lines carry the `failureCategory`.

## Behavior / fix

- Migrate each diagnostic site to `@ship/logger`: `console.warn` in `store/db.ts` + `store/store.ts`; `process.stderr.write("[ship-cloud-warn|error|debug] …")` in `cursor-runner`; bare `process.stderr.write(err.message)` diagnostics in `core/service.ts` + `mcp-server/bin.ts`. Carry structured fields (`{ workflowRunId, cursorRunId, phase }`), bound once per run via `log.child(...)`. Emit `failureCategory` on failure log lines (uses the enum from the sibling task).
- Wire the logger via DI from the entrypoints (`mcp-server`, `cli`) with `stream: process.stderr` so no module reaches stdout.
- **Leave CLI user-facing output/exits ALONE** — both the `--json`-aware `process.stdout.write` command output AND the `process.stderr.write(err.message)` + `process.exit(1)` error exits in `cli/commands/*` are user-facing, **not** diagnostics (design §8).

## Acceptance

- Zero remaining `console.*` / ad-hoc diagnostic `process.stderr.write` in `packages/*/src` (CLI user-facing output + error-exits excepted).
- Each migrated site logs structured fields; failure sites carry `failureCategory`.
- MCP-server diagnostics go to stderr only (stdout reserved for JSON-RPC).

## Test plan

- Grep guard: no `console.*` / stray diagnostic `stderr.write` outside the logger + the excepted CLI sites.
- **stdout purity:** extend the existing `e2e/integration/mcp-server.integration.test.ts` (stdio) with an assertion that every stdout line is valid JSON-RPC (design §8 — no new harness).
- Existing suites stay green; coverage gate green.

## Non-goals

- `get_workflow_run` / `ship diagnose` surface (Phase 2).
- The logger package or the enum/classifier (sibling tasks; this task consumes both).

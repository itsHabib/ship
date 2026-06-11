**Status**: shipped — PR #116 (squash `1d8c7d2`, 2026-06-09)
**Owner**: @michael
**Date**: 2026-06-02
**Related**: dossier task `observability-logger-package` (id: `tsk_01KTJH8EYJF9JB8BXKRXDHC2NK`); locked design [docs/features/observability/spec.md](../spec.md) §6 (Logger interface), §3, §4 D2/D3/D4.

# @ship/logger — structured logging package (interface + pino)

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | new `packages/logger/src/*` (interface + pino impl + config) + package.json/tsconfig | ~120 | 120 |
| Tests | `packages/logger/src/*.test.ts` | ~100 | 50 |
| **Total** | | | **~170** |

Band: **amazing** (< 500). New leaf package; no existing-source edits (the ~24 call-site migration is a separate task).

## Goal

Ship has no structured logging — ~24 ad-hoc `console.warn` / `process.stderr.write` sites, no logger library, no module (Audience A: "why did ship-the-tool misbehave?"). Add a structured (JSON) logger behind a narrow, swappable interface with a pino default, so diagnostics are queryable and one config governs every package.

## Behavior / fix

New leaf package **`@ship/logger`**:

- A narrow `Logger` interface:
  ```ts
  export interface Logger {
    debug(fields: LogFields, msg: string): void;
    info(fields: LogFields, msg: string): void;
    warn(fields: LogFields, msg: string): void;
    error(fields: LogFields, msg: string): void;
    child(fields: LogFields): Logger; // bind run-scoped context once
  }
  export interface LogFields {
    readonly workflowRunId?: string;
    readonly cursorRunId?: string;
    readonly phase?: string;
    readonly failureCategory?: string; // typed import lands with the enum task; string-tolerant here
    readonly [k: string]: unknown;
  }
  export function createLogger(opts?: { level?: string; pretty?: boolean; stream?: NodeJS.WritableStream }): Logger;
  ```
- pino-backed default impl. Config: `level` from `SHIP_LOG_LEVEL` (fallback `info`); `stream` defaults to `process.stderr`.
- **`pino-pretty` stays a `devDependency`; pretty is gated on dev (not bare TTY)** — production emits JSON-only and never loads the transport at runtime where it isn't installed (design §4 D4).
- The logger **swallows its own write errors** — a failed diagnostic write must never throw into business logic.
- Leaf in the dep graph (depends only on pino); no cycles (the `dep-direction` test stays green).

## Acceptance

- `@ship/logger` exports `createLogger` + `Logger` / `LogFields`; pino default writes JSON to `process.stderr`; level honored from `SHIP_LOG_LEVEL`.
- Pretty only in dev; production never requires `pino-pretty` at runtime.
- A below-level call is a near-noop; `child()` binds fields onto every subsequent line; write errors are swallowed.

## Test plan

Unit (`packages/logger/src/*.test.ts`): below-level call is a noop; JSON shape on stderr; `child()` field binding; stderr default stream; write-error swallowed; level read from `SHIP_LOG_LEVEL`.

## Non-goals

- Migrating the ~24 existing ad-hoc sites (separate task `observability-migrate-log-sites`).
- The `failureCategory` enum itself (separate task; `LogFields.failureCategory` is string-tolerant until that lands).
- Any logging sink/rotation/external exporter (design Non-goals — ship emits JSON; it doesn't ship the downstream).

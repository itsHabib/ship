# `@ship/logger`

## What this package owns

Structured application logging for Ship — a narrow `Logger` interface with a pino-backed default. Emits JSON to stderr in production; optional pretty output in development only.

## Public surface

- `createLogger(opts?)` — factory; honors `SHIP_LOG_LEVEL` (fallback `info`), defaults stream to `process.stderr`
- `Logger` — `debug` / `info` / `warn` / `error` + `child(fields)` for run-scoped context
- `LogFields` — structured field convention (`workflowRunId`, `cursorRunId`, `phase`, `failureCategory`, …)

## How it composes

Leaf package (`pino` only). Consumed by `store`, `cursor-runner`, `core`, `mcp-server`, and `cli` once call sites migrate. `pino-pretty` is a devDependency — production never loads it at runtime.

## Develop / test

```bash
pnpm --filter @ship/logger test
```

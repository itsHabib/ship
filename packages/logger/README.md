# `@ship/logger`

## What this package owns

Structured application logging for Ship — a narrow `Logger` interface with a pino-backed default. Emits JSON to stderr in production; optional pretty output in development only.

## Public surface

- `createLogger(opts?)` — factory; honors `SHIP_LOG_LEVEL` (fallback `info`), defaults stream to `process.stderr`
- `Logger` — `debug` / `info` / `warn` / `error` + `child(fields)` for run-scoped context
- `LogFields` — structured field convention (`workflowRunId`, `cursorRunId`, `phase`, `failureCategory`, …)

## How it composes

Leaf package (`pino` only). Consumed by `store`, `cursor-runner`, `core`, `mcp-server`, and `cli` once call sites migrate. `pino-pretty` is a devDependency — production never loads it at runtime.

## When to swap it

`Logger` is the contract; pino is one implementation behind `createLogger`. Callers depend only on the interface, so the backend is replaceable without touching call sites:

- Swap the default by writing a new `Logger` (e.g. an OpenTelemetry-backed or buffered impl) and a sibling factory; leave `Logger` / `LogFields` untouched.
- The narrow surface (`debug`/`info`/`warn`/`error`/`child`) is the intersection of what consumers need — keep it minimal so alternative backends stay cheap to satisfy.
- Don't leak pino types across the boundary. If a consumer reaches for a pino-specific feature, that's the signal to either widen the interface deliberately or keep the feature inside the pino impl.

## Develop / test

```bash
pnpm --filter @ship/logger test
```

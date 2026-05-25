# `@ship/cli`

## What this package owns

Human-facing Commander CLI for driving `ShipService` from the terminal. Parses flags, resolves XDG paths for the SQLite store, and formats `ShipOutput` for stdout. The binary entrypoint is `src/bin.ts`; tests construct `buildProgram()` directly with injected service factories.

## Public surface

- **`buildProgram(factory)`** — pure Commander program factory with four subcommands registered.
- **`ship ship <docPath>`** — blocking implement run via `ShipService.ship()` (waits for terminal state).
- **`ship status <workflowRunId>`** — print run summary + artifact paths.
- **`ship list`** — filter runs by repo/status/limit.
- **`ship cancel <workflowRunId>`** — idempotent cancel on in-flight runs.
- **`createCliService`** — wires default production deps (store path, cursor runners) for the real binary.

Run locally: `cd packages/cli && npx tsx src/bin.ts <subcommand>`.

## How it composes

Depends on `@ship/core` for `ShipService` and default wiring, `@ship/mcp` for input validation schemas, and re-exports boundary types from core so callers need not import `@ship/mcp` directly. Cursor execution flows through core → `@ship/cursor-runner`; persistence through core → `@ship/store`. Domain shapes come from `@ship/workflow`.

The MCP server (`@ship/mcp-server`) exposes the same service surface asynchronously via `startShip`; the CLI intentionally stays blocking for terminal ergonomics.

## When to swap it

Replace this package if the operator surface moves off Commander — e.g. a TUI, HTTP API, or IDE plugin. `ShipService` and the MCP server remain unchanged; only the argv → `ShipInput` adapter and stdout formatting would move. Swapping the agent runner or persistence layer does not touch this package.

## Develop / test

```bash
pnpm --filter @ship/cli test
```

Tests use `@ship/test-harness` for in-memory services and `program.exitOverride()` so Commander throws instead of calling `process.exit`. No package-specific build step — TypeScript via root `tsconfig` + Vitest.

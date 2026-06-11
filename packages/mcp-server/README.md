# `@ship/mcp-server`

## What this package owns

MCP stdio server exposing Ship's workflow verbs to Claude/Cursor sessions. Registers tools on `@modelcontextprotocol/sdk`'s `McpServer`, delegates to `ShipService` from `@ship/core`, and serves the `ship://runs/{workflowRunId}` resource for run snapshots.

## Public surface

- **`buildServer(shipFactory)`** — constructs the server, registers all tools + resource.
- **Tools (6)** — registered via `register*Tool` helpers in `src/tools/`:
  - **`ship`** — async kickoff via `ShipService.startShip()` → `ShipStartOutput`.
  - **`get_workflow_run`** — full run + phases + cursor rows, plus failure diagnostics (top-level `failureCategory` on failed runs, duration-vs-cap, `sdkTerminalStatus`, `recentEvents`, `watchUrl`).
  - **`list_workflow_runs`** — filtered listing.
  - **`cancel_workflow_run`** — idempotent cancel.
  - **`list_artifacts`** / **`download_artifact`** — cloud-run artifact manifest + on-demand fetch.
- **`ship://runs/{id}` resource** — JSON snapshot of a workflow run.
- **`src/bin.ts`** — production entry; `SHIP_TEST_FAKE_CURSOR=1` swaps in `FakeCursorRunner`.

The **PR-opening MCP tool was removed in PR #81** — PR creation is operator-side (`gh pr create`). Cloud runs may still pass `autoCreatePR` through the Cursor SDK via `@ship/cursor-runner`; Ship no longer exposes a first-class MCP verb for it.

## How it composes

Wires `createDefaultShipService` (or injected factory in tests) with `@ship/mcp` schemas for parse/validate at the tool boundary. All business logic lives in `@ship/core`; this package is thin registration + JSON serialization. Reads/writes go through core → `@ship/store`; agent execution through core → `@ship/cursor-runner`.

## When to swap it

Replace this package to change transport — HTTP MCP, SSE, or embedded in another host — without touching orchestration. New tools add a `registerFooTool` module + schema in `@ship/mcp` + handler method on `ShipService`. Swapping SQLite or the cursor runner does not require MCP-server changes unless the tool contract changes.

## Develop / test

```bash
pnpm --filter @ship/mcp-server test
cd packages/mcp-server && SHIP_TEST_FAKE_CURSOR=1 npx tsx src/bin.ts
```

Real Cursor SDK calls need `CURSOR_API_KEY`. Tests and local fake mode do not.

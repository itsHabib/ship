# `@ship/core`

## What this package owns

Workflow orchestration — `ShipService`, artifact I/O (NDJSON events, rendered prompt, `result.json`), and default production wiring consumed by `@ship/cli` and `@ship/mcp-server`. Owns the implement-phase state machine: validate input, record rows, launch cursor, finalize terminal state.

## Public surface

**Service**

- **`createShipService(deps)`** / **`ShipService`** — main orchestrator. `deps: ShipServiceDeps` bundles store, cursor runner, fs, clock, ids, and config; returns a `ShipService`.
- **`ship(input)`** — blocking implement run (CLI path); waits for terminal state, returns `ShipOutput`.
- **`startShip(input)`** — async MCP kickoff (V2 phase 01): registers active run, returns `{ workflowRunId, status: "running" }` immediately, continues in background.
- **`resumeOrphanedRuns()`** — on startup, re-attaches cloud cursor rows from `store.listResumableCloudCursorRuns()` via `CloudCursorRunner.attach` (V2 phase 08).
- **`resumeReady()`** — await the eager startup resume sweep before accepting new work.
- **`getRun` / `listRuns` / `cancelRun` / `drainBackground`** — inspect, filter, cancel, and flush in-flight continuations before `store.close()`.

**Failure diagnostics (PR #82)**

- Terminal failures walk the `Error.cause` chain (max depth 10) into a structured **`errorChain`** on persisted rows and `ShipOutput`.
- `result.json` is guarded against BigInt, circular refs, and non-JSON values (internal serializer — no public symbol, but the contract holds).

**Failure classification (observability P1/P2 — PRs #117/#124)**

- Both finalize paths classify failed runs via `@ship/cursor-runner`'s `classifyFailure`; the **`failureCategory`** + bounded `failureDetail` persist on the phase row, `errorMessage` becomes `<category>; <detail>`, and a structured `"run failed"` log line carries `{ workflowRunId, phase, failureCategory }`.
- `getRun` hoists the persisted category to the top-level output (failed runs only — never re-derived at read time).

**Wiring & artifacts**

- `createDefaultShipService`, `DEFAULT_MODEL`, `ShipServiceFactory`
- `ShipFs`, artifact path helpers, `renderImplementationPrompt`, domain errors
- Re-exports `ShipInput`, `ShipOutput`, `ListRunsFilter`, etc. so CLI/MCP-server avoid extra deps

## How it composes

Orchestrates `@ship/store` (persistence), `@ship/cursor-runner` (local + cloud agents), `@ship/workflow` (domain + transitions), `@ship/mcp` (wire schemas), and `@ship/logger` (structured stderr diagnostics, injected via the optional top-level `ShipServiceDeps.logger`). Does not import `@cursor/sdk` directly — ED-2 isolation keeps SDK usage in `cursor-runner`. Tests use `@ship/test-harness` for in-memory wiring.

## When to swap it

Core is the center of gravity. Replacing it means reimplementing the workflow state machine and artifact contract. Swapping `@ship/store` or `@ship/cursor-runner` is the intended seam — inject alternate `Store` or `CursorRunner` implementations via `ShipServiceDeps` without changing MCP or CLI surfaces.

## Develop / test

```bash
pnpm --filter @ship/core test
pnpm --filter @ship/core exec stryker run   # mutation testing; reports under reports/mutation/
```

Stryker runs in-place (`stryker.conf.json` `"inPlace": true`) because pnpm workspace symlinks break sandbox `instanceof` checks against `@ship/test-harness`-thrown errors. CI runs mutation on ubuntu as informational signal (`thresholds.break: null`).

Config: `stryker.conf.json`.

**Status**: draft
**Owner**: claude-code:michael
**Date**: 2026-05-25
**Related**: dossier task `polish-1-property-track` (id: `tsk_01KSE9NXBMRKRXZFHN68TKJS61`), polish-round-1 phase

# Property testing expansion across @ship/store, cursor-runner, workflow, core, mcp — design spec

## Scope

| Bucket | Files | Est. raw LOC | Weighted |
|---|---|---|---|
| New property tests | 6 new files | ~450 (75/file) | ~225 (tests 0.5×) |
| Extend existing | `transitions.properties.test.ts` | ~50 | ~25 |
| `package.json` tweaks (if needed) | up to 5 | ~10 | 0 (config) |
| **Total** | | ~510 | **~250 weighted** |

Band: **amazing** (<500 weighted).

## Goal

fast-check property tests on every major package that benefits. Pairs naturally with `polish-1-mutation-track`: mutation finds dead conditionals; property tests verify the boundary invariants the mutations would expose. The two are complementary — both should land in the same round.

fast-check is already a workspace dependency (used by `@ship/workflow`'s single existing property test).

## Behavior / fix

### `@ship/store` (2 new files)

- `packages/store/src/cursor-runs.properties.test.ts`
- `packages/store/src/workflow-runs.properties.test.ts`

Invariants to cover:

- **Run round-trip**: arbitrary `WorkflowRun` shapes that satisfy the schema → `insertWorkflowRun` → `getRun` → deep-equal the input (under shape constraints the schema permits).
- **Status filter correctness**: `listRuns({ status: [...] })` returns only rows where `row.status ∈ <filter>` under arbitrary status-list inputs.
- **Resume invariants**: `listResumableCloudCursorRuns` only returns rows where `cursor_run.status ∈ {"running", "pending"}` AND `workflow_run.status` is non-terminal. Property: no terminal-workflow rows surface from the resume sweep regardless of input.

Reuse the existing `:memory:` store setup from `cursor-runs.test.ts` / `workflow-runs.test.ts`.

### `@ship/cursor-runner` (2 new files)

- `packages/cursor-runner/src/_shared.properties.test.ts`

  - **Terminal status mapping**: `mapRunResult` + `mapTerminalResult` — for any valid SDK `RunResult` (use `fc.record` to generate), the returned `CursorRunResult.status ∈ {"succeeded", "failed", "cancelled"}`.
  - **Branch normalization**: `mapTerminalResult`'s `branches` array shape — every branch entry has `repoUrl` defined and is the right shape, regardless of which optional SDK fields the input populated.

- `packages/cursor-runner/src/cloud-runner.properties.test.ts`

  - **Boolean coercion**: `modelArgFromInput` — any `CursorRunInput.model.params` array with arbitrary `value: string | boolean` entries produces an `SdkModelSelection.params` array where every `value` is a string. (Mirrors the bug fixed in PR #82.)

### `@ship/workflow` (extend existing)

- `packages/workflow/src/transitions.properties.test.ts` — add properties for:
  - `isTerminal`: returns `true` iff status ∈ `TERMINAL_STATUSES`, for any string input.
  - `phaseKindSchema`: round-trip parse for all valid kinds, including the `"open_pr"` tombstone — `parse(stringify(x)) === x`.
  - `cursorRunRuntimeSchema`: accepts `"local"` and `"cloud"`; rejects any other string with a Zod error.
  - **Strict-optional handling**: schemas reject `{ field: undefined }` when the schema declares `field?: T` under `exactOptionalPropertyTypes`.

### `@ship/core` (1 new file)

- `packages/core/src/service.properties.test.ts` — state-machine invariants:
  - **Terminal status invariant**: across arbitrary sequences of `enqueue → ship` (followed optionally by `cancelRun`), the final `workflow_run.status` is always ∈ `{"succeeded", "failed", "cancelled"}`. Never `running` / `pending`.
  - **`cancelRun` idempotency**: calling `cancelRun(id)` twice produces the same row state — second call returns the same status as the first; no state regression.
  - **`errorChain` depth**: for any `Error` with `.cause` chain depth 0..10, `finalizeFailure`'s `errorChain` (read off the persisted `result.json`) has `length === min(depth + 1, 10)`. Validates the bounded-walk in `flattenErrorChain`.

Reuse the existing `createHarness` pattern (`:memory:` store + `FakeCursorRunner`).

### `@ship/mcp` (1 new file)

- `packages/mcp/src/mcp.properties.test.ts` — Zod schema round-trips:
  - **ShipInput round-trip**: arbitrary valid `ShipInput` (built via `fc.record`) → `JSON.parse(JSON.stringify(input))` → `shipInputSchema.parse(...)` → deep-equal the input.
  - **CloudRunSpec round-trip** including the `env: { type: "cloud" | "pool" | "machine"; name?: string }` discriminator. Property: round-trips preserve the discriminant.
  - **Runtime narrowing**: `cursorRunRuntimeSchema` accepts exactly `"local"` and `"cloud"`; rejects any other string.

## Packages explicitly skipped

- `@ship/cli` — argument parsing is covered by unit tests; property tests would mostly re-test commander.
- `@ship/mcp-server` — mostly glue / tool registration; weak fit.
- `@ship/test-harness` — test fixtures themselves; property-testing fixtures is a strange shape.

## Acceptance

- At least 12 properties total across the new + extended files.
- All deterministic — if a flake appears during development, lock the seed via `fc.assert(prop, { seed, path })`.
- `pnpm run test` green across all affected packages.
- `make check` green.

## Test plan

- `pnpm --filter @ship/store test --run properties` — runs the two new property test files
- `pnpm --filter @ship/cursor-runner test --run properties` — runs the two new property test files
- `pnpm --filter @ship/workflow test --run properties` — the extended properties file
- `pnpm --filter @ship/core test --run properties` — the new properties file
- `pnpm --filter @ship/mcp test --run properties` — the new properties file

Spot-check determinism: run each property file twice with the same seed env, confirm identical assertion counts.

## Non-goals

- Mutation testing (separate track — `polish-1-mutation-track`).
- Refactoring source to make properties cleaner — these tests target the existing surface.
- Property tests for the resume orchestration in `@ship/core` (could be follow-up; not in this round).
- Property tests for the CLI / mcp-server / test-harness packages (skipped above).
- Killing any mutants the property tests happen to expose (chips, not this PR).

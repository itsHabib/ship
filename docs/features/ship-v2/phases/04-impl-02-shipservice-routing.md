# Phase 04 impl PR #2 — `ShipService` routing + default wiring

Status: ready-to-ship — input to `ship.ship`.
Owner: itsHabib (driving), cursor (executing)
Date: 2026-05-18

> **Companion docs.** Parent design: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md). Predecessor impl: [04-cursor-cloud-runner-impl-01-skeleton.md](04-cursor-cloud-runner-impl-01-skeleton.md) (merged as PR #51 at `1d2d382` on 2026-05-18). Dossier task: `tsk_01KRWR04183706ASJA49AJKJ50` under phase `v2-cursor-cloud-runner`.

## Scope

**~80 src + ~160 tests (0.5×) = ~160 weighted LOC. "Amazing" band.** Do not exceed 500 weighted.

## Goal

Wire `ShipService` to dispatch by `input.runtime`:

- `input.runtime === "cloud"` → call the configured `CloudCursorRunner`.
- `input.runtime === "local"` or undefined → call the existing `LocalCursorRunner` (status quo).
- Missing `cloudCursor` config → throw `CloudRunnerNotConfiguredError` synchronously before any persistence.

Also close follow-up `tsk_01KRWPQ53S1X05W9JXABJABCY2` by tightening `LocalCursorRunner.run`'s discriminator guard against malformed values (`"Cloud"`, `"remote"`, etc.).

`default-wiring.ts` constructs both runners by default, so production callers (CLI, mcp-server) get cloud routing without opt-in. Tests / fakes can omit `cloudCursor` to assert the not-configured error path.

## Functional requirements

### F1 — `CloudRunnerNotConfiguredError` in `@ship/core`

New error type:

```ts
// packages/core/src/errors.ts
export class CloudRunnerNotConfiguredError extends Error {
  override readonly name = "CloudRunnerNotConfiguredError";

  constructor() {
    super("ShipService was constructed without cloudCursor; runtime: 'cloud' cannot be dispatched");
  }
}
```

This is a `@ship/core`-layer error, not a `@ship/cursor-runner`-layer error (per phase 04 § ED-7's split — the runner errors are about runtime input shape; this one is about service configuration). Don't add it to `cursor-runner/errors.ts`.

### F2 — `ShipServiceConfig.cloudCursor`

```ts
// packages/core/src/service.ts
export interface ShipServiceConfig {
  // ...existing fields...
  readonly cursor: CursorRunner;       // existing — defaults to LocalCursorRunner via default-wiring
  readonly cloudCursor?: CursorRunner; // NEW — defaults to CloudCursorRunner via default-wiring; optional for tests
}
```

`cursor` remains required (existing contract); `cloudCursor` is optional. Tests can omit it and assert the not-configured path.

### F3 — `ShipService.ship` routes by `input.runtime`

Routing happens at the start of `ship()` after input validation, before persistence:

```ts
async ship(input: ShipInput): Promise<ShipOutput> {
  // ...existing validation...
  const runner = this.#selectRunner(input);
  // ...existing persistence + run pipeline, but use `runner` instead of `this.config.cursor`...
}

#selectRunner(input: ShipInput): CursorRunner {
  if (input.runtime === "cloud") {
    if (this.config.cloudCursor === undefined) {
      throw new CloudRunnerNotConfiguredError();
    }
    return this.config.cloudCursor;
  }
  return this.config.cursor;
}
```

The thrown `CloudRunnerNotConfiguredError` must fire **before** any DB write or `cursor_runs` insert — same precondition-failure semantics as V1's `MissingApiKeyError` (no orphan rows).

### F4 — `cursor_runs.runtime` persists the chosen runtime

The `cursor_runs` table already has a `runtime` column (V1 schema, `0001_init.sql:48`). Existing inserts pass `runtime: "local"` hardcoded. For cloud routes, persist `runtime: "cloud"`.

The runtime to persist is derived from `input.runtime ?? "local"`. The store's `insertCursorRun` takes a `runtime: CursorRunRuntime` field; pass the resolved value through.

No schema migration. No new column. Just plumb the value through the existing path.

### F5 — `default-wiring.ts` constructs both runners

```ts
// packages/core/src/default-wiring.ts
import { CloudCursorRunner, LocalCursorRunner } from "@ship/cursor-runner";

export function defaultWiring(opts?: { cursor?: CursorRunner; cloudCursor?: CursorRunner }): ShipServiceConfig {
  return {
    cursor: opts?.cursor ?? new LocalCursorRunner(),
    cloudCursor: opts?.cloudCursor ?? new CloudCursorRunner(),
    // ...existing fields...
  };
}
```

(Adapt to the actual `default-wiring.ts` shape — the function may have a different signature today. The principle: both runners constructed eagerly by default; both overridable.)

### F6 — `LocalCursorRunner` runtime guard tightens (closes follow-up chip)

Today's `LocalCursorRunner.run` rejects only when `input.runtime === "cloud"`. Tighten:

```ts
// packages/cursor-runner/src/local-runner.ts
if (input.runtime !== undefined && input.runtime !== "local") {
  throw new WrongRunnerError(
    `LocalCursorRunner accepts runtime: "local" or undefined; received: ${String(input.runtime)}`,
  );
}
```

This rejects `"cloud"`, `"Cloud"`, `"remote"`, `null`, and any other malformed value. Defensive coding for non-TS callers; the load-bearing validation lives at the MCP schema boundary (impl PR #3).

Add the corresponding test cases in `local-runner.test.ts` (one per malformed value, parameterized if useful).

### F7 — Tests at every changed layer

In `packages/core/test/service.test.ts` (or equivalent location):

- `runtime: "cloud"` routes to `cloudCursor.run`; assert the cloud-runner mock is called, the local-runner mock is NOT.
- `runtime: "local"` routes to `cursor.run`; symmetric assertion.
- `runtime` undefined routes to `cursor.run` (default-local behavior).
- `runtime: "cloud"` + `cloudCursor: undefined` throws `CloudRunnerNotConfiguredError` synchronously; no rows in `cursor_runs`.
- `cursor_runs.runtime` is `"cloud"` for cloud routes, `"local"` for local routes (assert via store snapshot).

In `packages/core/test/default-wiring.test.ts`:

- Default construction wires both `LocalCursorRunner` and `CloudCursorRunner` instances.
- `cloudCursor` override path works (pass a fake, assert it's the wired one).
- `cursor` override path still works (existing test, regression check).

In `packages/cursor-runner/src/local-runner.test.ts`:

- `runtime: "Cloud"` (uppercase typo) throws `WrongRunnerError`.
- `runtime: "remote"` throws `WrongRunnerError`.
- `runtime` as `null` (non-TS caller) throws `WrongRunnerError`.
- `runtime: "local"` and `runtime: undefined` continue to pass (existing tests, regression check).

## Out of scope (this PR)

- `ship.ship` MCP schema extension — impl PR #3. **The Zod schema is the authoritative discriminator validation.** Runner-level guards (F6) become belt-and-suspenders once that lands.
- CLI flags — impl PR #4.
- L3 / live cloud scenarios — impl PR #5.
- `Agent.resume`, artifacts, GUI testing — phase-level deferrals.

## Acceptance

- `make check` green locally (typecheck + lint + format-check + test).
- **`pnpm run coverage` green** — global threshold 90% on lines / functions / branches / statements; per-file `service.ts`, `default-wiring.ts`, `local-runner.ts` all > 90%. **Confirm coverage locally before declaring done** — PR #51's CI failure was a coverage gate, not `make check`.
- No regression on existing tests in `cursor-runner` or `core`.
- Diff stays under 500 weighted LOC.
- Commit trailer per repo convention.

## Implementation plan

1. Add `CloudRunnerNotConfiguredError` to `packages/core/src/errors.ts`.
2. Extend `ShipServiceConfig` with `cloudCursor?`.
3. Implement `#selectRunner` in `ShipService.ship` per F3.
4. Plumb `runtime` through the `cursor_runs` insert path per F4 (the column exists; just pass the value).
5. Wire `default-wiring.ts` to construct both runners.
6. Tighten `LocalCursorRunner.run`'s runtime guard per F6.
7. Add the tests per F7.
8. `pnpm run coverage` in the affected packages; verify >= 90%.
9. `make check` green.
10. Commit + push. PR title: `feat(core): route ShipService runtime to CloudCursorRunner (phase 04 impl 2)`.

## Notes for the impl agent

- `CursorRunner` is substrate-agnostic — routing just means picking which instance. Don't refactor the interface.
- The error wrapping pattern matches V1's `MissingApiKeyError`: thrown before any persistence, surfaces cleanly through the MCP tool layer (the existing `isError: true` mapping in mcp-server picks new error types up automatically if they extend `Error`).
- Two `if` branches in `#selectRunner` is fine. Don't dedupe with a Map / Record lookup unless adding a third runtime — premature DRY (samurai-sword).
- The follow-up chip `tsk_01KRWPQ53S1X05W9JXABJABCY2` closes when F6 lands. Don't open a separate PR for it.
- Coverage gate is the new bar — don't trust `make check` alone. `pnpm run coverage` locally and inspect the per-file table before push.

## Cross-refs

- Parent design: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md) § F3 (`ShipService` routing), § ED-4 (`ShipServiceConfig`), § ED-7 (errors).
- Predecessor: PR #51 (CloudCursorRunner skeleton, merged at `1d2d382`).
- Follow-up closed by F6: `tsk_01KRWPQ53S1X05W9JXABJABCY2` (LocalCursorRunner discriminator validation).
- Existing `ShipService.ship`: [packages/core/src/service.ts](../../../../packages/core/src/service.ts).
- Existing `default-wiring.ts`: [packages/core/src/default-wiring.ts](../../../../packages/core/src/default-wiring.ts).

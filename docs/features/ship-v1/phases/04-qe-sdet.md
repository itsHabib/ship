# Phase 4 — QE/SDET: `packages/test-harness` + scenario suite + coverage gates

Status: design draft, revision 0 (2026-05-09). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-09

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec; § "Validation plan" enumerates the test categories this phase formalizes. [plan.md](../plan.md) lists this phase as a checkbox. [phases/03-store.md](03-store.md) shipped the package this phase first wraps in scenarios. The PR sizing rule in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:** ~250 src + ~350 tests = **425 weighted LOC** (under the < 500 amazing band).

Three concrete artifacts:
1. `@ship/test-harness` package — `Harness` class + fixtures + scenario helpers.
2. Initial scenario suite (5 scenarios) at the storage level.
3. CI coverage gates + e2e harness skeleton.

The package is dev-only (devDependencies of consumers). Phases 5–9 extend it with their own fakes (`FakeTowerAdapter`, `FakeCursorRunner`, etc.) and additional scenarios; each extension is its own PR per its phase doc.

## Summary

QE/SDET is a phase of its own, not a footnote in every package's task doc. This phase:

- **Codifies the test taxonomy** (unit / scenario / e2e) so phases 5–9 are written against agreed conventions instead of retrofitted.
- **Ships `@ship/test-harness`** — a small TypeScript package that owns the test fixtures, the `Harness` class (currently wrapping `@ship/store`), and helpers for scenario tests. It's only consumed via `devDependencies`; no production package depends on it.
- **Adds an initial scenario suite** that walks realistic workflow lifecycles (create → start → succeed; cancel mid-flight; phase failure; list with filters) at the storage level. Cursor / Tower are mocked in spirit because they don't exist yet; the scenarios drive the store with the same data shapes `core` will eventually produce.
- **Wires per-package coverage thresholds** into `vitest` config so CI fails on regression.
- **Stands up the e2e skeleton** under `e2e/` with a `SHIP_LIVE=1` gate; phases 5–9 plug in their real adapters.

It exists for two reasons:
1. **Conventions before code** — without a documented bar, every later phase makes its own call about what "tested enough" means; the bar drifts. With this phase landed, every package PR is reviewed against the same checklist.
2. **The harness itself is reusable** — phases 5–9 each introduce a fake plus a few new scenarios; without a shared package those duplicate across consumers.

## Functional requirements

### F1 — Test taxonomy (codified)

Three levels, formalized in this phase's task doc and enforced via directory layout + CI:

- **Unit tests** — `packages/<pkg>/src/**/*.test.ts`. Per-module, isolated. Use fakes/test doubles for adjacent layers. Fast (< 100ms per file). Run on every commit.
- **Scenario tests** — `packages/test-harness/scenarios/*.scenario.test.ts`. Walk multi-step flows that span several packages, using fakes for system boundaries (Cursor SDK, Tower MCP). Deterministic, fast (< 1s per scenario). Run on every commit.
- **E2E tests** — `e2e/**/*.test.ts` (root-level). Real Tower + real Cursor SDK against a fixture repo. Slow, opt-in via `SHIP_LIVE=1`. Run on demand / nightly only.

Vitest config matches: default `include` covers the first two; the e2e config is a separate `vitest.e2e.config.ts` that includes only the `e2e/` directory and is invoked via `make test:e2e`.

### F2 — `@ship/test-harness` package

A TypeScript package under `packages/test-harness/`. Layout:

```
packages/test-harness/
  package.json                # @ship/test-harness, private, dev-only
  tsconfig.json
  vitest.config.ts            # owns the scenario suite for THIS package
  src/
    index.ts                  # public barrel
    harness.ts                # the Harness class
    fixtures.ts               # sample worktree, policy, task doc
    clock.ts                  # createTestClock(start: string) → () => string with .advance(ms)
  scenarios/
    happy-path.scenario.test.ts
    cancel-mid-flight.scenario.test.ts
    phase-failure.scenario.test.ts
    list-filters.scenario.test.ts
    concurrent-readers.scenario.test.ts
```

Public surface (re-exported from `index.ts`):

```ts
export interface Harness {
  store: Store;
  clock: TestClock;
  ids: {
    workflowRun: () => string;
    phase: () => string;
    cursorRun: () => string;
  };
  close: () => void;
}

export interface CreateHarnessOptions {
  // dbPath defaults to ":memory:". Set to a temp file path to exercise WAL.
  dbPath?: string;
  // Advances on every call to ids.* by the given step. Default 1ms so
  // ULIDs sort in call order and `created_at` advances.
  clockStepMs?: number;
}

export function createHarness(opts?: CreateHarnessOptions): Harness;

// fixtures.ts
export const sampleWorktree: WorktreeRef;
export const samplePolicy: WorkflowPolicy;
export const sampleTaskDoc: string;

// clock.ts
export interface TestClock {
  (): string;
  advance: (ms: number) => void;
  set: (iso: string) => void;
}
export function createTestClock(start: string): TestClock;
```

`Harness` does NOT expose the underlying `db` handle. Tests that need to corrupt rows directly (the existing store hydration-error tests) keep their own setup; the harness is for scenario tests, not unit tests.

### F3 — Initial scenario suite

Five scenarios at the storage level (Cursor / Tower mocked because they don't exist yet — the scenario asserts the data shape `core` will eventually produce):

1. **Happy path** — `createWorkflowRun` → `appendPhase` → `recordCursorRun` → `updatePhase(succeeded)` → `updateWorkflowRunStatus(succeeded)`. Final `getRun` matches the expected hydrated shape; `getCursorRun` returns the recorded ref.
2. **Cancel mid-flight** — same up through `appendPhase` (`status: running`); then `cancelRun`. Both run + phase end at `cancelled` with `endedAt` set.
3. **Phase failure** — phase transitions to `failed` with `errorMessage`; run stays `running` until `core` decides (the store doesn't auto-cascade); test ends with `updateWorkflowRunStatus(failed)` and asserts the parent's `updated_at` was bumped at every step.
4. **List with filters** — seed 6 runs across 2 repos × 3 statuses; assert `listRuns({ repo: 'a' })`, `listRuns({ status: ['running'] })`, and `listRuns({ repo: 'a', status: ['running'] })` each return the right subset, ordered most-recent-first, with each row's `phases` correctly grouped.
5. **Concurrent readers** — file-backed dbPath; one connection writes a phase, a second connection reads `getRun` mid-write. The `busy_timeout` absorbs contention; both calls complete without `SQLITE_BUSY`. Documents the cross-process tolerance from spec.md § "Non-functional requirements".

Each scenario lives in its own `*.scenario.test.ts` file with a single `test(...)` call so failures are easy to attribute.

### F4 — Coverage gates in CI

Add to `vitest.config.ts` (root-level, applies to every workspace):

```ts
coverage: {
  thresholds: {
    statements: 85,
    branches: 80,
    functions: 85,
    lines: 85,
  },
}
```

Per-package overrides (where the surface justifies):

| Package | Statements | Branches | Reason |
|---|---|---|---|
| `@ship/workflow` | 95 | 90 | pure types + helpers; nothing to hide behind |
| `@ship/mcp` | 95 | 90 | same |
| `@ship/store` | 90 | 85 | high; SQL hydration is the contract |
| `@ship/test-harness` | 80 | 75 | most of it is exercised via consumers, not directly |

`make ci` (the existing CI target) gains a `coverage` step that fails on regression. New `make coverage` target for local runs.

### F5 — E2E harness skeleton

Top-level `e2e/` directory:

```
e2e/
  vitest.e2e.config.ts        # only included when SHIP_LIVE=1
  fixtures/
    test-repo/
      README.md
      docs/features/hello.md  # the task doc the e2e ships
  scenarios/
    .gitkeep                  # phases 5+ add real e2e tests here
```

Phase 4 ships:
- The directory layout.
- `vitest.e2e.config.ts` that reads `SHIP_LIVE` and exits cleanly with "no e2e tests run" otherwise.
- The fixture repo + sample task doc.
- A README at `e2e/README.md` explaining how to enable e2e locally.

Phase 4 does NOT add real e2e tests. Those land alongside the real adapters (phases 5, 6) and the dogfood milestone (phase 10).

## Non-functional requirements

- **Zero side effects on import.** `@ship/test-harness` doesn't open a DB or spawn processes at module load; `createHarness()` does.
- **Synchronous Harness API.** Mirrors `@ship/store`. Async APIs arrive only when consuming-package fakes need them (phases 5–6).
- **Strict TS + lint matching the rest of the repo.** Test code is held to the same bar as production source (the lint config already relaxes `max-lines-per-function` for `*.test.ts`).
- **Vitest workspace mode** — root `vitest.config.ts` already drives every package's tests; this phase doesn't change that.
- **No new third-party deps.** Vitest, v8 coverage, and the existing toolchain cover everything.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Harness lives in a workspace package | `packages/test-harness` | Top-level `test/` dir | pnpm workspace consistency; clean import paths (`@ship/test-harness`); future packages depend on it via `devDependencies` cleanly |
| Scenario format | Programmatic test functions | YAML / JSON declarative | TS gives autocomplete + types + jump-to-definition; declarative format would need a runtime to interpret |
| Coverage tool | v8 (already in vitest config) | nyc / c8 | already installed; v8 is the modern default |
| Coverage gate placement | per-package thresholds in `vitest.config.ts` | single repo-wide threshold in CI yaml | per-package catches regressions early; different packages have different surface |
| E2E gating | `SHIP_LIVE=1` env var | separate workflow file | spec.md § "Validation plan" already specifies this convention |
| Fakes location | each consumer ships its own fake; harness composes them | fakes live in `@ship/test-harness` | each fake is intimate with its host package; co-location keeps the fake in step with the real |
| When to run e2e | on-demand + nightly | every PR | e2e against real Cursor + Tower is slow, flaky, and expensive |

## Engineering decisions

### ED-1 — `@ship/test-harness` is dev-only

The package's `package.json` declares no `main`/`exports` outside the test path. Every consumer adds it as `devDependencies: { "@ship/test-harness": "workspace:*" }`. CI verifies the dep direction: nothing in `dependencies` ever points at the harness.

### ED-2 — Scenarios are typed test functions, not declarative

A scenario is `async (h: Harness) => Promise<void>`. The wrapping vitest test calls `createHarness()`, awaits the scenario, asserts, then `h.close()`. Failures are stack traces, not YAML schema errors.

### ED-3 — Test clock is a fluent helper

`createTestClock("2026-05-09T00:00:00.000Z")` returns a callable that auto-advances by 1ms each call (so ULIDs sort and `created_at` differs row-to-row) plus `.advance(ms)` and `.set(iso)` for explicit control. Mirrors the pattern `core` will use in its own tests.

### ED-4 — Coverage thresholds in `vitest.config.ts`

Not in CI yaml, not in a separate config file. Co-located with the rest of the test config so local `pnpm test --coverage` produces the same gating result as CI.

### ED-5 — E2E tests are co-located in `e2e/`, not under each package

Per spec.md § ED-4, run artifacts live under `<UserConfigDir>/ship/`; tests do too. The e2e suite is conceptually "drive the binary against a fixture repo," which spans packages — putting it under one package's tests would be misleading.

### ED-6 — `Harness` does not expose the raw `db` handle

Tests that need raw SQL access (the existing hydration-error path tests in `@ship/store`) construct their own `db` directly via `better-sqlite3`. The harness is for scenario tests, not unit tests; mixing the two would let scenario tests drift into testing implementation details.

### ED-7 — `FakeCursorRunner` / `FakeTowerAdapter` ship from their host packages

Each fake is intimate with its real implementation; co-locating them keeps the two in step. The harness imports them via `devDependencies` and exposes a uniform `Harness` shape regardless. Future-Habib who renames a Cursor SDK event only has to update the fake in `@ship/cursor-runner`, not the harness.

## API boundaries / contracts

The public surface re-exported from `packages/test-harness/src/index.ts`:

```ts
// === harness.ts ===
export type { Harness, CreateHarnessOptions } from "./harness.js";
export { createHarness } from "./harness.js";

// === fixtures.ts ===
export {
  sampleWorktree,
  samplePolicy,
  sampleTaskDoc,
  sampleCreateWorkflowRunInput,
  sampleAppendPhaseInput,
  sampleRecordCursorRunInput,
} from "./fixtures.js";

// === clock.ts ===
export type { TestClock } from "./clock.js";
export { createTestClock } from "./clock.js";
```

Nothing else is public. Scenario test files re-export their `*.scenario.test.ts` collateral as `*.test.ts` for vitest discovery.

### Stability promise

The `Harness` interface is the contract every later phase's tests code against. Adding fields is fine; renaming/removing is a breaking change that updates every consuming test in the same commit.

## Validation plan

Tests live in `packages/test-harness/scenarios/*.scenario.test.ts` plus a small set of unit tests for the harness itself.

### Harness construction

- ✅ `createHarness()` returns a working `Harness` with an in-memory store and a deterministic clock.
- ✅ `dbPath: tempfile` produces a file-backed store; the file exists after the call.
- ✅ `harness.close()` closes the store cleanly; subsequent calls throw.

### Scenarios (each its own `*.scenario.test.ts` file)

- ✅ Happy path round-trips through `createWorkflowRun` / `appendPhase` / `recordCursorRun` / `updatePhase` / `updateWorkflowRunStatus`; `getRun` matches.
- ✅ Cancel mid-flight: both run + phase end `cancelled`; `endedAt` set on the phase.
- ✅ Phase failure: phase ends `failed` with `errorMessage`; parent's `updated_at` bumped.
- ✅ List with filters: `repo` only, `status[]` only, both; `phases` grouped correctly per row.
- ✅ Concurrent readers (file-backed): two connections; no `SQLITE_BUSY`; both transactions complete.

### Coverage gates

- ✅ Each package's `pnpm test --coverage` reports coverage and respects the threshold.
- ❌ Deliberate coverage drop (delete a test) fails CI.

### E2E skeleton

- ✅ `pnpm test --config vitest.e2e.config.ts` with `SHIP_LIVE` unset exits 0 with "no tests run" semantics.
- ✅ With `SHIP_LIVE=1` and no real adapters yet, the suite exits cleanly with the same shape (phases 5–6 fill in real tests later).

### Acceptance

- `pnpm --filter @ship/test-harness test` exits 0.
- `pnpm typecheck` / `lint` / `format:check` from repo root pass.
- `make coverage` passes thresholds.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Coverage gates become an end in themselves | False sense of security; tests pad to hit %s | Document that the gate is a floor, not a ceiling; PR review still applies |
| Scenarios drift as packages evolve | Tests break or, worse, lie | Scenarios live in `@ship/test-harness` and reference shared fixtures; one update touches all consumers |
| `Harness` accumulates kitchen-sink helpers | Test infra grows unbounded | Per-method JSDoc justifies why each helper exists; new helpers go through the same review bar as production code |
| E2E flake from real services | Random CI failures discredit the suite | Behind `SHIP_LIVE=1`, run nightly only; mark known-flaky scenarios explicitly in the doc |
| Fakes drift from real implementations | Tests pass but real flow breaks | Each fake's host package owns its CI; fake + real share a TS interface, drift is a typecheck failure |

## Open questions

1. **Coverage threshold values.** Proposed `85/80` repo-default with per-package overrides above. Pulled from a tower-style baseline; revisit after a few cycles if it's too aggressive or too lax.
2. **Should scenarios live in `@ship/test-harness` or in each consumer?** Proposed: harness owns the cross-package scenarios; each consumer owns its own unit tests + per-package scenarios that exercise just that package's surface. Boundary is "does this scenario need fakes from more than one host?" If yes → harness; if no → consumer.
3. **Test repo location.** Proposed: `e2e/fixtures/test-repo/` inside this repo, gitignored from the regular CI lifecycle. Alternative is a separate throwaway repo registered via Tower; keeping it inline avoids cross-repo setup but bloats checkouts slightly.
4. **`SHIP_LIVE=1` enforcement.** Proposed: vitest config's `include` is empty unless `SHIP_LIVE=1`; no separate workflow file in V1. We add a workflow file when there's enough e2e to justify a nightly run.

## Implementation plan

After review/approval, implement in this order:

1. **`packages/test-harness/{package.json, tsconfig.json, vitest.config.ts}`** — workspace wiring per Phase 2's pattern. Deps: `@ship/store`, `@ship/workflow` (`workspace:*`); devDeps: `vitest`.
2. **`src/clock.ts` + tests** — `createTestClock` with `.advance` / `.set`.
3. **`src/fixtures.ts`** — sample worktree, policy, task doc, and per-input fixtures.
4. **`src/harness.ts` + tests** — `createHarness({ dbPath?, clockStepMs? })`; `Harness` object; `close()`.
5. **`src/index.ts`** — barrel.
6. **`scenarios/happy-path.scenario.test.ts`** — first scenario.
7. **`scenarios/cancel-mid-flight.scenario.test.ts`** — second.
8. **`scenarios/phase-failure.scenario.test.ts`** — third.
9. **`scenarios/list-filters.scenario.test.ts`** — fourth.
10. **`scenarios/concurrent-readers.scenario.test.ts`** — fifth (file-backed; opens two connections).
11. **Coverage gates** — add `coverage.thresholds` to root `vitest.config.ts`; add per-package overrides where listed in F4.
12. **`make coverage` target** — `pnpm test --coverage`; surfaces the threshold check locally.
13. **E2E skeleton** — `e2e/` directory, `vitest.e2e.config.ts`, fixture repo, README.
14. **`pnpm install` + `make check`** from repo root — must be green.
15. **Mark Phase 4 done in [plan.md](../plan.md).**

Total LOC estimate (per CLAUDE.md weighting): ~250 src + ~350 tests = **425 weighted** (under 500 amazing). Wall time: 3–4h.

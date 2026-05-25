# `@ship/test-harness`

## What this package owns

Dev-only test substrate for the Ship monorepo. Provides in-memory SQLite stores, a deterministic test clock, scripted `FakeCursorRunner`, sample fixtures, and L3 scenario tests that exercise full `ShipService` flows without API keys or disk state.

## Public surface

- **`createHarness(options?)`** — `:memory:` store + fake cursor + test clock + temp workdir layout.
- **`createServiceFromHarness(harness)`** — returns a wired `ShipService` (`ServiceBundle`).
- **`createTestClock()`** — controllable `Date.now` for timeout/resume tests.
- **Fixtures** — `sampleTaskDoc`, `sampleWorktree`, `samplePolicy`, factory helpers for workflow/phase/cursor-run inputs.
- **`waitForTerminalRun(client, workflowRunId)`** — polls MCP-style until a run reaches terminal state (used in scenario tests).

Scenario tests live in `scenarios/*.scenario.test.ts` (happy path, cancel mid-flight, cloud resume, list filters).

## How it composes

Wires `@ship/core` + `@ship/store` + `@ship/cursor-runner/test/fake` + `@ship/workflow`. Every shipping package lists this under `devDependencies`. There is an intentional cyclic dev dependency with `@ship/core` — harness imports core to build services; core tests import harness for fixtures. Not published or run in production.

## When to swap it

Prefer this harness over inline fakes when you need a full `ShipService` stack (store + cursor + clock) or L3 scenario coverage. Use bare `FakeCursorRunner` directly only for narrow unit tests that mock `ShipService` deps themselves. If tests need Tower or live Cursor SDK, they belong in `e2e/` (L4), not here.

## Develop / test

```bash
pnpm --filter @ship/test-harness test
```

Scenarios run as part of the package's Vitest suite. No separate binary or env vars beyond optional `SHIP_TEST_FAKE_CURSOR=1` when driving the real MCP server in integration tests.

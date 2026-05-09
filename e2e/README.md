# Ship e2e tests

Real-services end-to-end suite. Drives the `ship` binary against the fixture
repo at `e2e/fixtures/test-repo/` using a real Tower instance and the real
Cursor SDK.

Phase 4 ships only the scaffolding. Phase 5–10 land actual tests under
`e2e/scenarios/` as the corresponding adapters arrive.

## Layout

```
e2e/
  vitest.e2e.config.ts        # SHIP_LIVE-gated config
  fixtures/
    test-repo/                # throwaway repo cloned for each e2e run
      README.md
      docs/features/hello.md  # the task doc the e2e ships
  scenarios/                  # *.e2e.test.ts files (none yet)
```

## Running locally

The suite is gated by `SHIP_LIVE=1`. When unset, vitest exits cleanly with
"no tests run":

```
pnpm exec vitest run --config e2e/vitest.e2e.config.ts
```

To enable e2e (requires a `CURSOR_API_KEY` and a running Tower instance):

```
SHIP_LIVE=1 CURSOR_API_KEY=... pnpm exec vitest run --config e2e/vitest.e2e.config.ts
```

## CI

The default CI workflow does NOT run e2e — it's slow, costs API quota, and
flakes on real services. A nightly workflow (added when there's enough e2e to
justify it) will set `SHIP_LIVE=1` and gate on green.

## Adding a scenario

1. Create `scenarios/<name>.e2e.test.ts`.
2. Use `@ship/test-harness`'s `Harness` for the in-process pieces (store, clock).
3. Construct the real adapters (`TowerAdapter` from phase 5, `CursorRunner` from
   phase 6) directly — the harness's fakes are only for non-e2e tests.
4. The scenario should leave the fixture repo in a state matching the asserted
   outcome; cleanup via `afterAll` (delete the worktree).

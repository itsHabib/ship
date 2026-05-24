# Ship e2e tests

Real-services end-to-end suite. Drives the `ship` CLI (+ MCP in integration tests) against real SQLite on disk, real `git`, and—when explicitly opt-in—real Cursor + GitHub.

## Layout

```
e2e/
  vitest.e2e.config.ts        # SHIP_LIVE-gated config for L4
  fixtures/
    test-repo/                 # hello-world L4 fixture (Phase 9)
    live-sandbox/               # shared L3/L4 live-sandbox fixture
  integration/                  # L3 subprocess + disk tests (always on)
  scenarios/                    # *.e2e.test.ts — L4 live Cursor/GitHub
```

## Running locally

### L3 integration (default)

Runs on every `pnpm exec vitest run --config e2e/vitest.e2e.config.ts` **without** `SHIP_LIVE=1`:

```
pnpm exec vitest run --config e2e/vitest.e2e.config.ts
```

### L4 live (`SHIP_LIVE=1`)

Requires:

- `SHIP_LIVE=1`
- `CURSOR_API_KEY` — real Cursor SDK
- `GITHUB_TOKEN` — repo scope: push to sandbox + `pulls` read/write
- `SHIP_E2E_SANDBOX_REPO` — `owner/repo` for a **dedicated throwaway** GitHub repository (operator-owned; not created by Ship)

Optional: `SHIP_E2E_VERBOSE=1` streams subprocess stdout + enables verbose vitest reporter (long runs feel less “hung”).

```
SHIP_LIVE=1 CURSOR_API_KEY=... GITHUB_TOKEN=... SHIP_E2E_SANDBOX_REPO=owner/sandbox \
  pnpm exec vitest run --config e2e/vitest.e2e.config.ts
```

## Sandbox repository checklist (one-time)

Per phase doc / CLAUDE.md PR sizing: Ship does **not** provision the sandbox. The operator:

1. Creates an empty GitHub repo (e.g. `itsHabib/agent-sandbox`).
2. Disables branch protection on `main` (L4 force-pushes fixture `main`).
3. **Disables GitHub Actions** on the repo (Settings → Actions) so pushes don’t burn workflow quota.
4. Ensures `GITHUB_TOKEN` can **force-push** to `main` and create PRs from `tower/live-e2e-*` branches.

## L4 quota (per-file JSDoc)

Each `e2e/scenarios/*.e2e.test.ts` file carries a short JSDoc “**Quota:** …” line at the top (Cursor runs + PRs + any extra git pushes). The aggregate cost is high by design—**CI does not run L4 by default.**

## Taxonomy pointer

Test-layer taxonomy (L3 vs L4, bug-smash cadence) lives in [`docs/features/qe-sdet/spec.md`](../docs/features/qe-sdet/spec.md). [`CLAUDE.md`](../../CLAUDE.md) links there from “Docs layout”.

# `@ship/core`

Workflow state machine, `ShipService`, `OpenPrService`, and related Ship internals.

## Mutation testing

This package runs [Stryker](https://stryker-mutator.io/) against Vitest to find test gaps (mutations that survive because no test fails).

**Local run** (from repo root):

```bash
pnpm --filter @ship/core exec stryker run
```

Reports are written under `reports/mutation/` (open `mutation.html` in a browser; `mutation.json` is also emitted).

Stryker’s default `@stryker-mutator/*` plugin glob does not resolve `@stryker-mutator/vitest-runner` under pnpm’s layout, so `stryker.conf.json` uses `appendPlugins` to load it explicitly.

`stryker.conf.json` also sets `"inPlace": true` (no sandbox copy). The default sandbox mode breaks pnpm-workspace symlinks: `@ship/test-harness` resolves back to the *original* `@ship/core`, while tests in the sandboxed `src/` import from the *sandbox copy*. The two paths produce different class identities, so `instanceof` checks against errors thrown by harness-instantiated services fail (e.g. `open-pr.test.ts` → `ImplementPhaseNotSucceededError`). `inPlace: true` keeps a single source-of-truth on disk; Stryker stamps a backup under `.stryker-tmp/backup-*` and restores after the run.

**CI:** Mutation testing runs on every push + PR as part of the standard `CI` workflow (`.github/workflows/ci.yml`), ubuntu-only (one OS is enough signal at this cost). Surviving mutants do NOT fail the build — `stryker.conf.json` sets `thresholds.break: null` so mutation runs are informational. Real test gaps surface in the HTML report and become chips per the protocol below.

**Follow-up:** Review surviving mutants in the HTML report. Real gaps become work items (chips) with reproducer (mutator name + line). Deliberately ignored cases use `// @stryker-disable-next-line <mutator>` plus a `// reason:` line per repo comment convention.

Config: `stryker.conf.json`.

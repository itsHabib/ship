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

**CI:** A nightly GitHub Actions workflow (`Mutation testing`) runs the same command on a schedule (07:00 UTC) and on manual dispatch. It uploads the report as a workflow artifact (`stryker-report-core`, 30-day retention). Mutation score is advisory—`thresholds.break` is unset so the job does not fail on surviving mutants.

**Follow-up:** Review surviving mutants in the HTML report. Real gaps become work items (chips) with reproducer (mutator name + line). Deliberately ignored cases use `// @stryker-disable-next-line <mutator>` plus a `// reason:` line per repo comment convention.

Config: `stryker.conf.json`.

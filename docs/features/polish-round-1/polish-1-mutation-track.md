**Status**: draft
**Owner**: claude-code:michael
**Date**: 2026-05-25
**Related**: dossier task `polish-1-mutation-track` (id: `tsk_01KSE9N9H9K1JMV4EJXAHX4WE8`), polish-round-1 phase

# Mutation testing expansion + CI reorganization — design spec

## Scope

| Bucket | Files | Est. raw LOC | Weighted |
|---|---|---|---|
| CI workflows | `.github/workflows/ci.yml` (edit), `.github/workflows/mutation.yml` (new) | ~120 | ~120 |
| Stryker configs | 6 × `packages/<pkg>/stryker.conf.json` | ~90 (15/file) | 0 (configs) |
| README touch | top-level 1-line addition | ~3 | 0 (docs) |
| **Total** | | ~213 | **~120 weighted** |

Band: **amazing** (<500 weighted) per CLAUDE.md PR sizing.

## Goal

Mutation testing on every shipping package, but pulled out of every-PR CI into an on-demand `workflow_dispatch` job. Default CI on PR no longer runs Stryker; an operator (or a manual UI button) fires `mutation.yml` to run Stryker across all 7 packages (existing core + 6 new) in a matrix.

Today: only `@ship/core` has Stryker; runs informational on every PR (ubuntu-only, ~5–10 min); no one actions surviving mutants → pure cost. This task makes mutation a real on-demand signal across the whole shipping surface.

## Behavior / fix

### 1. CI reorganization

- **Remove** the `Mutation testing (@ship/core)` step from `.github/workflows/ci.yml` (currently runs only on `ubuntu-latest` with `if: matrix.os == 'ubuntu-latest'`).
- **Add** `.github/workflows/mutation.yml`:
  - `on: workflow_dispatch` (mandatory).
  - Optionally `on: schedule: - cron: '0 6 * * 1'` (Monday 6am UTC) — include if cheap; skip if it adds noise.
  - Job matrix over all packages with a `stryker.conf.json`. `fail-fast: false`. Each matrix entry runs `pnpm --filter @ship/<pkg> exec stryker run`.
  - Same Node/pnpm setup as `ci.yml`.

### 2. Per-package Stryker configs

Add `stryker.conf.json` to each of the 6 packages below, mirroring `packages/core/stryker.conf.json`:

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "appendPlugins": ["@stryker-mutator/vitest-runner"],
  "testRunner": "vitest",
  "vitest": { "configFile": "vitest.config.ts" },
  "mutate": ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.d.ts"],
  "reporters": ["html", "json", "clear-text"],
  "thresholds": { "high": 80, "low": 60, "break": null },
  "concurrency": 4,
  "timeoutMS": 60000,
  "logLevel": "info",
  "inPlace": true
}
```

Packages to cover:

- `@ship/cli` — command parsers, arg validation, option resolution.
- `@ship/cursor-runner` — SDK boundary, error mapping (`mapAgentNotFoundError`, `mapRunResult`, `mapTerminalResult`), state machine (`#startAgent`, `#runPipeline`, `attach`).
- `@ship/mcp` — Zod schemas + discriminated-union refinement (cloud spec, runtime narrowing).
- `@ship/mcp-server` — tool registration glue + error mapping.
- `@ship/store` — SQLite query layer (`listResumableCloudCursorRuns`, `getRun`, `listRuns`), row hydration.
- `@ship/workflow` — state machine (`isTerminal`, `phaseKindSchema` including `open_pr` tombstone, transitions).

`@ship/core` already has Stryker; do NOT re-add. `@ship/test-harness` skipped (test fixtures, no production code).

### 3. Local verification

Run `pnpm --filter @ship/<each> exec stryker run` once per package locally to confirm it finishes end-to-end. Capture survivor counts. Per-survivor fixes are **out of scope** — file chips via `mcp__ccd_session__spawn_task` for any worth addressing. Triage > fix here.

### 4. README hint

Add one line to top-level `README.md`'s "Develop" section pointing at `gh workflow run mutation.yml` for the manual trigger. The bigger README rewrite lives in `polish-1-readme-track`; this is just an entrypoint hint so `mutation.yml` doesn't silently disappear from discoverability.

## Acceptance

- Default CI on a fresh PR no longer runs Stryker.
- `gh workflow run mutation.yml` fires Stryker across all 7 configured packages (core + 6 new); each matrix entry passes end-to-end.
- Each new config is reachable: `pnpm --filter @ship/<pkg> exec stryker run` runs without harness errors.
- Survivor counts noted in the PR description (with chip links if any worth follow-up).
- `make check` green.

## Test plan

- `pnpm --filter @ship/core exec stryker run` — re-verify the existing core mutation path still finishes end-to-end after the CI reorg (acceptance covers all 7 packages, not just the 6 new ones)
- `pnpm --filter @ship/cli exec stryker run` — end-to-end run, captures survivor count
- `pnpm --filter @ship/cursor-runner exec stryker run` — same
- `pnpm --filter @ship/mcp exec stryker run` — same
- `pnpm --filter @ship/mcp-server exec stryker run` — same
- `pnpm --filter @ship/store exec stryker run` — same
- `pnpm --filter @ship/workflow exec stryker run` — same
- `make check` — verify no regressions

CI-side verification: trigger `mutation.yml` from the PR via `gh workflow run mutation.yml --ref <branch>` once the workflow file is on the branch, confirm all matrix entries reach a terminal status.

## Non-goals

- Property testing (separate track — `polish-1-property-track`).
- Killing surviving mutants (chips, not this PR).
- Top-level README rewrite (separate track — `polish-1-readme-track`).
- Threshold changes (`high:80 / low:60 / break:null` stays).
- Adding Stryker to `@ship/test-harness` (fixtures don't need mutation).

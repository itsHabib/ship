# Phase 02 — Mutation testing on `@ship/core`

Status: design draft, revision 0 (2026-05-16). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-16

> **Companion docs.** [../spec.md](../spec.md) § "Coverage is a floor, mutation score is the ceiling" motivates this phase. Sibling: [phases/03-property-based-state-machine.md](03-property-based-state-machine.md) (parallel testing-rigor technique). Predecessor: [phases/01-l4-expansion-and-bug-smash.md](01-l4-expansion-and-bug-smash.md) — Phase 01 lands first because it's the larger immediate deliverable; this phase composes cleanly afterward but doesn't depend on it. The PR-sizing rule in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:**

| Item | Weight | Estimate |
|---|---|---|
| `packages/core/stryker.conf.json` | 0× (config) | ~30 LOC |
| `.github/workflows/mutation.yml` | 0× (config) | ~40 LOC |
| `packages/core/package.json` devDep additions | 0× | trivial |
| `packages/core/README.md` mutation-testing section | 0× | ~20 LOC docs |
| **Total weighted** | | **~0 LOC** |

Pure config + workflow + docs. No production source touched. No new tests rewritten — surviving mutants become chips per `spec.md` § "Bug-smash is a continuous practice".

**Time budget:** ~2h impl + ~30min validation + ~1h first-nightly review.

## Summary

Mutation testing closes the gap between line coverage (what tests visit) and behavior coverage (what tests actually catch). The toolchain is Stryker (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`).

In scope: `@ship/core` only — the workflow state machine + `ShipService` + `OpenPrService` are the most logic-dense parts of Ship; surviving mutants here are most informative. Other packages opt in via their own follow-up phase docs if signal warrants.

Output: a nightly CI workflow that produces a mutation-score report. Surviving mutants don't fail CI; they become chips. The threshold is advisory, not gating. The HTML report uploads as a workflow artifact for operator review.

## Functional requirements

### F1 — Stryker config on `@ship/core`

`packages/core/stryker.conf.json` (new file):

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "vitest": { "configFile": "vitest.config.ts" },
  "mutate": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/*.d.ts"
  ],
  "reporters": ["html", "json", "clear-text"],
  "thresholds": { "high": 80, "low": 60, "break": null },
  "concurrency": 4,
  "timeoutMS": 60000,
  "logLevel": "info"
}
```

Key choices (see ED-1 for tooling rationale):

- `testRunner: "vitest"` — uses the existing vitest config; no test rewrites.
- `mutate` includes all `src/**/*.ts` except tests + ambient `.d.ts`.
- `thresholds.break: null` — surviving mutants don't fail the run. Surfacing, not gating.
- `concurrency: 4` — empirical default for a 4-vCPU CI box; tune in F4 if nightly wall-clock is too long.

### F2 — Nightly CI workflow

`.github/workflows/mutation.yml` (new file):

```yaml
name: Mutation testing
on:
  schedule:
    - cron: "0 7 * * *"  # 07:00 UTC daily
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  mutation-core:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @ship/core exec stryker run
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: stryker-report-core
          path: packages/core/reports/mutation/
          retention-days: 30
```

Triggers: scheduled (07:00 UTC = 03:00 ET) + manual dispatch. Never on PR. HTML report uploads as a workflow artifact for review.

### F3 — Surviving mutants become chips

After each nightly run:

1. Workflow artifact contains `mutation/html/index.html` (Stryker's visualizer).
2. Operator reviews surviving mutants in the HTML report.
3. Each surviving mutant representing a real test gap → chip via `mcp__ccd_session__spawn_task`.
4. Each surviving mutant that's deliberately untestable (e.g. trivial tautology) gets a `// @stryker-disable-next-line <mutator>` annotation, not a chip.

Per phase 9 ED-1, every chip carries a reproducer (the Stryker mutator name + the line it survived on) and a suggested approach.

### F4 — Tune `concurrency` only if needed

First-run target: ≤30 min wall-clock. If overshoots, raise `concurrency` (from 4 → 6 or 8) or narrow `mutate` to a subset of files in a follow-up. Don't touch `timeoutMS` unless individual mutants time out (separate signal, separate chip).

## Non-functional requirements

- **No production code touched.** Mutation testing reads source, never writes it. Config + workflow + docs only.
- **No new production dependency.** `@stryker-mutator/*` are devDependencies in `@ship/core`.
- **Coverage thresholds remain in force.** Mutation testing is additive to coverage gating, not a replacement.
- **Nightly runtime budget.** First-run target ≤ 30min wall-clock; hard cap 45min via `timeout-minutes: 45`. If consistently overshoots, narrow scope in a follow-up.
- **Per-package opt-in.** This phase touches `@ship/core` only. Adding `@ship/workflow` / `@ship/store` is a separate phase doc if signal warrants.
- **No CI gate.** Mutation runs never fail CI. The gate is the chip-review pipeline (per `spec.md` § Philosophy).

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Tool | Stryker | manual rewrite-and-rerun | Stryker is the de facto Node mutation tool; vitest-runner is first-class. No competing maintained alternative. |
| Test runner adapter | `@stryker-mutator/vitest-runner` | Jest adapter via compat shim | Repo is vitest-native; the official adapter exists. No compat shim needed. |
| Per-PR vs nightly | Nightly only | Per-PR | Mutation runtime is minutes-to-hours per package. Per-PR would block normal merges. Nightly is the only sustainable cadence. |
| Surviving mutants gate CI | No (`break: null`) | Threshold-fail at X% | Mutation score is feedback, not a gate. Hard gate forces chasing the score, missing the point. |
| Scope: `@ship/core` only | Yes | All packages | Samurai-sword. Start with the package that has the most logic; extend per follow-up. |
| Config location | `packages/core/stryker.conf.json` | Root-level | Per-package matches the `vitest.config.ts` convention. Future packages get their own config. |
| Report retention | GitHub workflow artifacts (30 days) | Persistent storage (S3, gh-pages) | 30 days is enough for trend review; no infra cost. Move to gh-pages later if a long-term history matters. |
| Disable-comment vs chip for deliberate skips | Disable-comment (`// @stryker-disable-next-line`) | Always chip | An obviously-untestable mutation (tautology) shouldn't pollute the chip queue. Disable-comments are reviewer-gated. |

## Engineering decisions

### ED-1 — Stryker over alternatives

Stryker is the only actively-maintained TypeScript-aware mutation tool. The runner integration with vitest is official. `pitest` (Java), `mull` (C++) aren't TS-targeted. Manually-driven mutate-and-rerun loops require building the mutator catalog from scratch; Stryker has 50+ mutators out of the box.

### ED-2 — Nightly schedule + manual dispatch, never PR

`schedule.cron: "0 7 * * *"` runs daily at 07:00 UTC. `workflow_dispatch` lets the operator trigger on demand (e.g. after a major refactor lands). Never on PR — runtime makes per-PR unsustainable. Matches phase 4 § F4's deferred "nightly cadence for slow-tail jobs" model.

### ED-3 — Surviving mutant → chip, not in-tree fix

Per `spec.md` § Philosophy ("continuous practice"), feedback flows through the chip queue. Each surviving mutant that's a real gap becomes a `mcp__ccd_session__spawn_task` chip; the chip's PR adds the missing test. The mutation workflow itself never modifies production code or tests — decouples "find gaps" (mutation) from "fix gaps" (chip → test PR).

### ED-4 — `@stryker-disable` comments are review-gated

A surviving mutant annotated as `// @stryker-disable-next-line ConditionalExpression` declares "this mutant is intentionally not killed." Annotations are reviewer-checked in the PR that adds them; reviewers ensure the annotation isn't masking a real gap. Annotations include a one-line `// reason:` comment per the existing repo `//`-only comment convention.

### ED-5 — `break: null` means CI never fails on mutation score

Stryker's `thresholds.break` would exit non-zero below a score. Setting it to `null` makes the workflow informational. Per ED-3, the gate is the chip-review pipeline, not the workflow exit code.

### ED-6 — `high: 80, low: 60` for color-coding only

The thresholds are advisory: scores ≥80% render green in the HTML report, ≥60% yellow, <60% red. Picked from Stryker's "typical Node project" guidance. Revisit after the first 4 weeks of nightly data.

### ED-7 — `concurrency: 4` is the first guess; tunable

Stryker mutants run in parallel test processes. 4 is reasonable for a 4-vCPU GitHub-hosted runner. Tune in a follow-up phase doc if nightly wall-clock exceeds 30 minutes.

### ED-8 — `timeout-minutes: 45` in the workflow caps blast radius

A runaway Stryker run shouldn't burn a CI runner indefinitely. 45 minutes is well above the 30-min target and lets a marginal slow run finish; a 45-min hit signals tuning is needed.

## Validation plan

### Acceptance for the design PR (this doc)

- Doc reviewed + merged on `main`.

### Acceptance for the impl PR

- `packages/core/stryker.conf.json` valid against the `$schema` reference.
- `.github/workflows/mutation.yml` runs on `workflow_dispatch` and produces a `stryker-report-core` artifact.
- First on-demand run produces a non-empty HTML report; mutation score recorded in this doc's "Outcome" section.
- `packages/core/README.md` documents local invocation (`pnpm --filter @ship/core exec stryker run`) + nightly cadence.

### Acceptance for the practice

- The first nightly produces ≥ 1 surviving mutant → at least 1 chip filed via `mcp__ccd_session__spawn_task`.
- The chip's follow-up PR adds a test that kills the mutant.
- The next nightly shows the mutation score improving by ≥ 1 percentage point (or remaining flat with the corresponding `@stryker-disable` annotations + reasons).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Nightly runtime overshoots 30 min | CI quota burn + missed signal if devs ignore | `concurrency` tunable; can narrow `mutate` to a subset; 45-min hard cap in the workflow (ED-8). |
| Surviving mutants are unfixable noise | Chips clog the queue with low-value items | ED-4: `@stryker-disable` annotations document deliberate skips. The 8-cap from phase 9 applies overall. |
| Mutation score becomes a vanity metric | Devs chase the score instead of meaningful tests | ED-5 + ED-3: no CI gate; the *chip* (and the test it adds) is the deliverable, not the percentage. |
| `vitest-runner` breaks on a Stryker upgrade | Nightly silently red | `pnpm install --frozen-lockfile` pins versions; Renovate / dependabot upgrades land as their own PRs with the runtime validated. |
| Stryker reports leak source in workflow artifacts | Privacy / IP | Repo is private; artifacts inherit visibility. Public repos would need `actions/upload-artifact` permission scoping reviewed. |
| First nightly burns quota without producing chips | Wasted CI minutes | Acceptance for the practice (above) requires ≥1 chip filed; if zero chips three nightlies running, file a `02b` doc to investigate (is the tool wired wrong? are tests actually exhaustive?). |
| Cron collides with future workflows on the same `0 7 * * *` | Resource contention | Single nightly is fine; if more land, stagger by 15-min increments. |

## Out of scope

- **Mutation testing on packages other than `@ship/core`.** `@ship/workflow`, `@ship/store`, etc. each get their own phase doc if signal warrants. Phase 02 starts narrow per samurai-sword.
- **Rewriting tests to kill surviving mutants.** Each chip's PR does that work. This phase ships the workflow + config, not the test rewrites.
- **Threshold tuning.** First 4 weeks of nightly data informs whether `high: 80` / `low: 60` are right. Revisit in a follow-up after data lands.
- **Per-PR mutation runs.** Runtime makes this unsustainable; nightly is the only viable cadence.
- **Mutation testing as a release gate.** Mutation score is feedback, not promotion criteria. Reviewers + tests + L1–L4 layers are the gates.
- **Auto-generating chips from the report.** Could be a future automation; in V1 the operator (or a future agent reviewer) curates.

## Open questions

1. **Add `@ship/workflow` in this phase or a follow-up?** Proposed: follow-up. `@ship/workflow` is small (pure transition helpers) but worth its own phase doc once `@ship/core`'s nightly is stable.
2. **HTML report storage long-term?** Workflow artifacts default 30d (per F2's `retention-days`). Move to gh-pages or S3 only if the operator wants a longer history.
3. **Should `vitest-runner` be a hard pin?** Currently floats per pnpm range. Pin to exact version if a Stryker minor bump regresses behavior; track via Renovate.
4. **What's the chip-filing cadence?** Proposed: review the nightly report once a week (Monday morning), file chips for the ≤5 most impactful surviving mutants. Don't try to chip every mutant — that overflows the 8-cap immediately.

## Implementation plan

After this doc is reviewed and merged:

1. **Add devDependencies** to `packages/core/package.json`: `@stryker-mutator/core` + `@stryker-mutator/vitest-runner`. Pin to latest stable.
2. **Add `packages/core/stryker.conf.json`** per F1.
3. **Add `.github/workflows/mutation.yml`** per F2.
4. **Test locally:** `pnpm --filter @ship/core exec stryker run`. Verify `reports/mutation/` is populated. Verify the workflow runs on `workflow_dispatch` once pushed.
5. **Add `packages/core/README.md` § Mutation testing** documenting local invocation + nightly cadence + the chip-filing protocol from F3.
6. **First nightly review.** After the first scheduled run, populate this doc's "Outcome" section with the mutation score + first chip(s) filed.

Total weighted LOC: **~0** (config + workflow + docs). Wall time: ~2h impl + ~30min validation + ~1h first-run review.

## Outcome

*Populated after the first nightly run: mutation score on `@ship/core`, first chip filed (with link), surviving-mutant count, runtime measured.*

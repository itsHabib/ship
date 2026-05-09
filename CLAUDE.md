# Ship

A repo-native dev-workflow MCP toolkit. **Pre-implementation** as of 2026-05-06 — Phase 0 (Cursor SDK spike) and Phase 1 (monorepo scaffold) done; no package code yet. See [docs/features/ship-v1/plan.md](docs/features/ship-v1/plan.md) for what's next.

## Docs layout

- `docs/<topic>.md` — locally cached reference docs (external SDKs, protocols, specs).
- `docs/features/<feature>/spec.md` — design spec for that feature.
- `docs/features/<feature>/plan.md` — execution plan with phase checkboxes for that feature.

Start with the active feature's `spec.md`, then its `plan.md`. The plan tracks what's done and what's next.

## Develop

```
pnpm install
make check          # typecheck + lint + format-check + test
```

CI on `.github/workflows/ci.yml` runs the same `make check` matrix on ubuntu + windows. Lint/format/test rules live in `eslint.config.js`, `.prettierrc`, `vitest.config.ts`. TS strict knobs in `tsconfig.base.json`.

## How Ship fits

- `../tower` owns repos, worktrees, PR/CI/review snapshots. Ship calls it; Ship doesn't reimplement it.
- `@cursor/sdk` owns coding-agent execution.
- Ship owns workflow state, persistence, and the MCP surface above the other two.
- inspired by lessons learned from ../orchestra ../cortex

## Shipping Features
Follow this general workflow for implementing a feature
- implement said feature
- create a branch if you haven't already
- create a PR
- request copilot as reviewer
- comment "@codex review"
- comment "@claude review"
- ensure CI is green
- ensure review comments are addressed
  - it's ok to be opinionated, don't have to take all comments blindly
- repeat the review cycle 3 times before reaching out
- when ready to merge reach out

## PR sizing

Target weighted-LOC bands per PR:

| Band | Limit |
|---|---|
| amazing | < 500 |
| ideal | < 700 |
| stretch | < 1000 |

Weights:

- production source (incl. JSDoc) + SQL + bash: **1.0×**
- tests + fixtures: **0.5×**
- lockfiles, generated, configs (`tsconfig.json`, `vitest.config.ts`, `package.json` boilerplate), docs: **0×**

A phase task doc declares the weighted budget in a **Scope** section near the top (right after `Status` / `Owner` / `Date`). If the budget exceeds 700, the doc must either split into multiple phase docs OR justify the no-split inline (tightly coupled state machine, single SQL schema you can't ship half of).

The phase doc's "Implementation plan" step list is the natural PR boundary. When there are more than ~3-4 distinct steps, treat each step (or small group) as its own PR — not as substeps inside one PR. Reviewers flag a wrong-shape budget at design time, not after a 1500-LOC PR is open.
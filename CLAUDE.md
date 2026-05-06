# Ship

A repo-native dev-workflow MCP toolkit. **Pre-implementation** as of 2026-05-06 — Phase 0 (Cursor SDK spike) and Phase 1 (monorepo scaffold) done; no package code yet. See [docs/plan.md](docs/plan.md) for what's next.

## Read first

In order:

1. [docs/features/ship-v1.md](docs/features/ship-v1.md) — V1 task doc, authoritative scope.
2. [docs/plan.md](docs/plan.md) — execution plan, in order, with checkboxes per phase.
3. [docs/cursor-sdk-typescript.md](docs/cursor-sdk-typescript.md) — locally cached `@cursor/sdk` reference; source of truth for the runner shape.

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
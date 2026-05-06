# Ship

Repo-native dev-workflow MCP toolkit. Given a task doc and a registered Tower repo, Ship creates a worktree, launches a Cursor SDK agent against it, and persists what happened. V2 phases (PR opening, agent reviews, CI repair) compose on top of V1 — they are not part of V1.

**Status:** pre-implementation; Phase 1 (monorepo scaffold) only. See [PLAN.md](PLAN.md) for the execution plan and [docs/features/ship-v1.md](docs/features/ship-v1.md) for the V1 spec.

## Stack

- TypeScript + pnpm workspaces
- Vitest + Zod
- SQLite via Drizzle (planned, Phase 3)
- `@cursor/sdk` as the agent runtime, wrapped in `packages/cursor-runner` (planned, Phase 5)
- MCP TS SDK as both client (toward Tower) and server (Ship's own surface)

## Develop

```bash
pnpm install
make check        # typecheck + lint + format-check + test
make test-watch
make lint-fix
make format
```

Or via pnpm directly:

```bash
pnpm run check
pnpm run test:watch
```

## Layout

See [docs/features/ship-v1.md § Architecture](docs/features/ship-v1.md#architecture) for package boundaries and dependency direction.

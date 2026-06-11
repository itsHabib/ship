# Ship

Repo-native dev-workflow MCP toolkit. Ship hands a task doc to a Cursor agent (local worktree or cloud), persists workflow state in SQLite, and exposes inspect/cancel verbs over MCP. Cloud-run resume happens at process startup inside `@ship/core`, not as an MCP tool. The repo dogfoods itself — feature work lands via `mcp__ship__ship` against task docs in worktrees.

## Status

**V1 feature-complete** on `main` (Phases 0–9). **V2** phases shipped: **01** (async `ship` kickoff), **03** (subagent passthrough), **04** (Cursor cloud runner), **08** (`Agent.resume` for orphaned cloud runs). The PR-opening MCP verb was removed in PR #81; PR creation is operator-side (`gh pr create`). Cause-chain failure diagnostics and boolean-coerce fixes landed in PR #82.

**Observability** (P1+P2, PRs #116/#117/#120/#124): structured JSON logging via [`@ship/logger`](packages/logger/README.md) (stderr, `SHIP_LOG_LEVEL`), a canonical **`failureCategory`** classified and persisted on failed runs (`contention` / `timeout-near-cap` / `agent-collapse-on-running-tool` / `sdk-throw` / `logic` / `unknown`; rows persisted before the migration stay unclassified), and a diagnosis surface — `get_workflow_run` carries the category top-level and `ship diagnose <wf>` prints category + error + duration-vs-cap + last activity. Design: [docs/features/observability/spec.md](docs/features/observability/spec.md).

See [docs/features/ship-v1/plan.md](docs/features/ship-v1/plan.md) for V1 history and [docs/features/ship-v2/spec.md](docs/features/ship-v2/spec.md) for V2 design and phase docs under `docs/features/ship-v2/phases/`.

## Quick start

```bash
pnpm install
make check   # typecheck + lint + format-check + test (604+ L1/L2 tests, no API keys)
```

**Dogfood pattern** (how this repo ships itself):

1. Write a task doc under `docs/features/<feature>/phases/<NN>-<slug>.md`.
2. Spin up a worktree (`/worktree-add <branch>`) or use Cursor cloud runtime.
3. Kick off: `mcp__ship__ship { workdir, docPath, repo, branch }` — returns `{ workflowRunId, status: "running" }` immediately (V2 async).
4. Poll terminal: `mcp__ship__get_workflow_run { workflowRunId }` or read `ship://runs/{id}`.
5. Failed run? `ship diagnose <workflowRunId>` prints the classified `failureCategory`, error, duration-vs-cap, and last activity — no `events.ndjson` digging.
6. Commit, push, open PR with `gh pr create`.

CLI equivalent (blocking): `cd packages/cli && npx tsx src/bin.ts ship <docPath> --repo <name>` (`--repo` is required; `--workdir` / `--branch` are optional).

## Architecture

Ten pnpm workspace packages, dependency direction inward toward `@ship/core`:

| Package | Role |
|---------|------|
| [`cli`](packages/cli/README.md) | Terminal verbs over `ShipService` |
| [`core`](packages/core/README.md) | Orchestration — `ShipService`, artifacts, default wiring |
| [`cursor-runner`](packages/cursor-runner/README.md) | Sole `@cursor/sdk` boundary — local + cloud runners, failure classifier |
| [`logger`](packages/logger/README.md) | Structured JSON logging — narrow `Logger` interface, pino default |
| [`mcp`](packages/mcp/README.md) | Zod wire schemas for MCP tool I/O |
| [`mcp-server`](packages/mcp-server/README.md) | MCP stdio server — tool registration + `ship://runs` resource |
| [`receipt`](packages/receipt/README.md) | Run-receipt layer — one queryable row per unit of agent work |
| [`store`](packages/store/README.md) | SQLite persistence behind the `Store` interface |
| [`test-harness`](packages/test-harness/README.md) | In-memory fixtures + scenario helpers for tests |
| [`workflow`](packages/workflow/README.md) | Domain schemas, transitions, ID factories |

Ship owns workflow state and the MCP surface. [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) owns agent execution. Tower (external) owns repo/worktree/PR snapshots when integrated — Ship calls it, doesn't reimplement it.

## Develop

```bash
pnpm install
make check              # CI-equivalent full gate
pnpm run test:watch     # Vitest watch mode
make lint-fix && make format   # auto-fix lint + format
```

Per-package tests: `pnpm --filter @ship/<package> test`.

On-demand mutation testing across shipping packages:

```bash
gh workflow run mutation.yml   # requires GitHub CLI auth
```

MCP server (fake runner, no API key):

```bash
cd packages/mcp-server && SHIP_TEST_FAKE_CURSOR=1 npx tsx src/bin.ts
```

Integration (L3) and live e2e (L4, opt-in keys): `make integration`, `make e2e`. See [AGENTS.md](AGENTS.md) for the command matrix.

## Docs map

Feature work lives under `docs/features/<feature>/`:

- **`spec.md`** — design spec (what and why)
- **`plan.md`** — execution plan with phase checkboxes
- **`phases/<NN>-<slug>.md`** — per-phase task docs (input to `ship.ship`)

Cached external references sit at `docs/<topic>.md`. Test-layer taxonomy (L1–L4): [docs/features/qe-sdet/spec.md](docs/features/qe-sdet/spec.md).

## Workbench

Ship sits in a portfolio dev-workbench alongside dossier (project memory), huddle (multi-seat coordination), and `/worktree-*` skills. The **Dev workbench** section in [CLAUDE.md](CLAUDE.md) documents when to call each verb — use it as the operator reference for MCP tools and skills beyond Ship itself.

## License

Licensed under [MIT](LICENSE).

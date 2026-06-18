# Ship

A repo-native dev-workflow MCP toolkit. Hand a task doc to a coding agent (Cursor), run it in a local git worktree or on Cursor cloud, and keep a durable, queryable record of exactly what happened. Inspect, diagnose, cancel, or replay any run over an MCP server or a terminal CLI. Kickoff is async: fire a run and walk away. The record outlives the process.

Ship has two headline surfaces, and both are first-class.

- **Single-run** fires one agent at one task doc, then lets you inspect, diagnose, or cancel it. This is the unit of work.
- **The driver engine** (`ship driver`) drives N parallel work streams from a `driver.md` manifest all the way to merge, through a deterministic state machine that an agent or a human advances one bounded tick at a time. It is the engine-based successor to the hand-run `/work-driver` loop.

The repo dogfoods both: ship work lands via ship against task docs in worktrees, and every PR here passes through ship at least once.

## Why it exists

Ship is one swappable layer in a portfolio dev-workbench, sitting above the agent runtime and below the planning layer. It owns workflow state, persistence, and the verb surface that lets an operator or an autonomous driver reach into a run after the fact. Everything else stays out of scope: planning lives in dossier (project memory), worktrees come from the `/worktree-*` skills, PR creation is plain `gh pr create`, and agent execution belongs to `@cursor/sdk`.

That narrow charter buys a durable, queryable record of every agent run plus a clean async-kickoff and diagnosis surface. An operator can launch dozens of runs, close the laptop, and come back to a list of classified failures instead of a wall of `events.ndjson`. The driver engine scales the idea up to many streams at once: a manifest goes in, merged PRs come out, with a decision point surfaced whenever a stream gets stuck.

Because each concern lives behind an interface, the seams stay swappable. A different planner, a different worktree mechanism, or a different agent runner (a Claude Code SDK runner, a local subprocess) can substitute in without rippling through the other layers.

## MCP surface

The stdio server registers 9 tools (6 single-run + 3 driver) plus the `ship://runs/{id}` resource. This is the primary programmatic surface, and kickoff is async.

| Tool | Family | What it does |
|------|--------|--------------|
| `ship` | single-run | Async kickoff. Returns `{ workflowRunId, status: "running" }` immediately and continues in the background. |
| `get_workflow_run` | single-run | Full run + phases + cursor rows + failure diagnostics (top-level `failureCategory`, duration-vs-cap, `recentEvents`, `watchUrl`). |
| `list_workflow_runs` | single-run | Filter runs by repo / status / limit. |
| `cancel_workflow_run` | single-run | Idempotent cancel. |
| `list_artifacts` / `download_artifact` | single-run | Cloud-run artifact manifest plus on-demand fetch. |
| `driver_run` | driver | One bounded engine tick: dispatch eligible streams, poll in-flight ones, surface anything needing judgment. |
| `driver_status` | driver | Durable driver-run state across all streams and batches. |
| `driver_decide` | driver | Apply a judgment decision to a stuck stream (`retry` / `skip` / `abort` / `adopt`). |

The `ship://runs/{id}` resource returns a JSON snapshot of any run.

```jsonc
// kickoff into a local worktree
mcp__ship__ship { workdir, docPath, repo, branch }

// kickoff on cloud, no local worktree
mcp__ship__ship { docPath, runtime: "cloud", cloud: { repos: [{ url }] } }
```

Both return `{ workflowRunId, status: "running" }` immediately. Poll for a terminal state with `get_workflow_run`, or read the `ship://runs/{id}` resource for a snapshot. The same `driver_run` tick an autonomous brain calls is the one a human runs at the terminal, so the engine advances identically either way.

Real Cursor calls need `CURSOR_API_KEY`. For local development with no key, `SHIP_TEST_FAKE_CURSOR=1` swaps in a fake runner.

## CLI surface

The CLI is its own first-class surface with blocking, terminal-friendly ergonomics. Two families.

**Single-run** verbs block until a terminal state:

| Command | What it does |
|---------|--------------|
| `ship ship <docPath> --repo <name>` | Blocking implement run, waits for a terminal state. `--repo` required; `--workdir` / `--branch` optional. |
| `ship status <workflowRunId>` | Run summary plus artifact paths. |
| `ship diagnose <workflowRunId>` | One-view failure diagnosis: classified `failureCategory`, error, duration-vs-cap, last activity, watch URL. `--json` for enriched output. |
| `ship list` | Filter runs by repo / status / limit. |
| `ship cancel <workflowRunId>` | Idempotent cancel. |
| `ship artifacts list\|download <workflowRunId>` | Inspect or fetch cloud-run artifacts. |
| `ship prune` | Delete terminal-run artifacts older than a cutoff. `--dry-run` to preview. |

**Driver** verbs operate the multi-stream engine:

| Command | What it does |
|---------|--------------|
| `ship driver import <manifestPath>` | Import a `driver.md` manifest into the store. |
| `ship driver run <ref>` | One bounded engine tick (auto-imports when `ref` is a manifest path). `--batch <n>`, `--max-wait <dur>` (default 20m), `--poll-interval <dur>` (default 30s), `--force` to override a live tick lease. |
| `ship driver decide <driverRunId> <retry\|skip\|abort\|adopt> --stream <ds_id>` | Apply a judgment decision. `--reason` for skip/abort, `--workflow-run` for adopt. |
| `ship driver mark-merged <driverRunId> --stream <ds_id> --pr <n> --sha <sha>` | Record merge facts for a landed stream. |
| `ship driver render <driverRunId>` | Render the current `driver.md` from store rows. `--out` to write it. |
| `ship driver status <driverRunId>` | Durable driver-run state. `--json` for machine-readable. |
| `ship driver cancel <driverRunId>` | Cancel an in-flight driver run. |

The driver loop in practice: import a manifest once, then call `ship driver run` (or the MCP `driver_run`) repeatedly, by hand or on a `/loop`, answering with `ship driver decide` whenever a stream needs a call, until every stream is merged.

```bash
ship driver import driver.md                                  # once
ship driver run driver.md                                      # bounded tick (auto-imports a manifest path)
ship driver decide <driverRunId> retry --stream <ds_id>        # answer a judgment point
ship driver mark-merged <driverRunId> --stream <ds_id> --pr 42 --sha <sha>
ship driver status <driverRunId> --json
```

Run either surface from source:

```bash
# MCP server, fake runner (no API key)
cd packages/mcp-server && SHIP_TEST_FAKE_CURSOR=1 npx tsx src/bin.ts

# CLI
cd packages/cli && npx tsx src/bin.ts <subcommand>
```

## The driver state machine

A driver run groups streams into file-overlap-safe batches and walks each one through six stages. Bounded ticks make the run crash-safe and resumable: every transition is durable in the store, so a tick can die and the next `driver run` picks up exactly where it left off.

```
  import ──▶ dispatch ──▶ poll ──▶ judgment ──▶ land ──▶ mark-merged
 manifest    fire         check    stuck?        PR        record pr
 into        eligible     in-flight  │           ready     + sha
 store       streams      streams    │
                                     ▼
                       driver_decide / ship driver decide
                       retry · skip · abort · adopt
```

`judgment` is the only stage where a human or brain agent is asked to decide. Everything else advances on its own.

## Failure diagnosis

Failed runs get a canonical `failureCategory`: `contention`, `timeout-near-cap`, `agent-collapse-on-running-tool`, `sdk-throw`, `logic`, or `unknown`. The category plus a bounded slice of detail persist on the run, and both `ship diagnose` and `get_workflow_run` surface it, so diagnosing a failure doesn't mean hand-reading `events.ndjson`. Logging is structured JSON via `@ship/logger` (stderr, level set by `SHIP_LOG_LEVEL`).

## Architecture

Ship is an 11-package pnpm workspace. Dependencies point inward toward `@ship/core`.

```
   planning (dossier)        worktrees (/worktree-* skills)        PR (gh)
         │                          │                               │
         ▼                          ▼                               ▼
 ┌───────────────────────────────── Ship ──────────────────────────────────┐
 │                                                                          │
 │   mcp-server ──┐                              ┌── cli                    │
 │   (9 tools +   │     surface (mcp schemas)    │   (single-run + driver   │
 │   ship://runs) │                              │    terminal verbs)       │
 │                ▼                              ▼                           │
 │           ┌──────────────────── core ───────────────────┐               │
 │           │  ShipService · implement-phase state machine │               │
 │           └─────┬──────────────────┬───────────┬─────────┘               │
 │                 │                  │           │                         │
 │           cursor-runner         driver       store ──── workflow         │
 │          (sole @cursor/sdk    (multi-stream  (SQLite   (schemas,         │
 │           boundary; local +    work-driver    behind    transitions,     │
 │           cloud; classifier;    engine)       Store)    ID factories)    │
 │           cloud resume)            │             ▲                       │
 │                                    └── receipt ──┘                       │
 │                             logger · test-harness                        │
 └───────────────────────────────────┬──────────────────────────────────────┘
                                      ▼
                         @cursor/sdk (agent execution)
```

| Package | Role |
|---------|------|
| [`cli`](packages/cli/README.md) | Terminal verbs over `ShipService` plus the driver engine. |
| [`core`](packages/core/README.md) | Orchestration: `ShipService`, the implement-phase state machine, artifacts, default wiring. |
| [`cursor-runner`](packages/cursor-runner/README.md) | The sole `@cursor/sdk` boundary (ED-2 SDK isolation). Local + cloud runners, failure classifier; resumes orphaned cloud runs (attach) at startup. |
| [`driver`](packages/driver/README.md) | The multi-stream work-driver engine: `driver.md` parsing/validation, store import, the deterministic dispatch/poll/judgment loop, render. |
| [`logger`](packages/logger/README.md) | Structured JSON logging behind a narrow `Logger` interface (pino default). |
| [`mcp`](packages/mcp/README.md) | Zod wire schemas for MCP tool I/O. |
| [`mcp-server`](packages/mcp-server/README.md) | MCP stdio server: registers the 9 tools + the `ship://runs` resource. |
| [`receipt`](packages/receipt/README.md) | Run-receipt layer: one queryable row per unit of agent work. |
| [`store`](packages/store/README.md) | SQLite persistence behind the `Store` interface (single-run rows + driver run/stream/batch rows). |
| [`test-harness`](packages/test-harness/README.md) | In-memory fixtures + scenario helpers for tests. |
| [`workflow`](packages/workflow/README.md) | Domain schemas, transitions, ID factories. |

The boundaries are deliberate. `@cursor/sdk` owns agent execution. Ship owns workflow state, the MCP/CLI surface, and the driver engine. dossier owns planning, the `/worktree-*` skills own worktrees, and `gh` owns PR creation. Tower (external, when integrated) owns repo/worktree/PR snapshots that Ship calls into rather than reimplements. The intended swap seam: inject an alternate `Store` or `CursorRunner` through `ShipServiceDeps`, and neither the MCP server, the CLI, nor the driver notices.

## Develop

```bash
pnpm install
make check          # typecheck + lint + format-check + coverage (L1/L2, no API keys)
```

`make check` runs hundreds of L1/L2 unit tests with no API keys, the same gate CI enforces on Ubuntu and Windows. While iterating:

```bash
pnpm run test:watch                  # vitest watch
make lint-fix && make format         # auto-fix
pnpm --filter @ship/<package> test   # one package
make integration                     # L3
make e2e                             # L4, opt-in live keys
```

See [`AGENTS.md`](AGENTS.md) for the full command matrix and each package's own README for internals.

## Docs map

Feature work lives under `docs/features/<feature>/`: `spec.md` (design), `plan.md` (execution), and `phases/<slug>.md` (per-phase task docs that are the input to `ship`). Cached external references sit at `docs/<topic>.md`.

## License

[MIT](LICENSE).

# Phase 7 — `packages/cli`

Status: design draft, revision 0 (2026-05-10). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-10

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec; § "Component responsibilities" and § "F1–F5" pin what `cli` is wrapping. [phases/06-core.md](06-core.md) shipped the `ShipService` interface this phase consumes. The PR sizing rule + dep-boundary preference in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:** ~280 src + ~280 tests = **420 weighted LOC** total — comfortably inside the < 500 amazing band, so **lands as a single PR**. No split.

| Sub-PR | Source | Tests | Weighted | Boundary |
|---|---|---|---|---|
| **7** binary + four subcommands + smoke tests | ~280 | ~280 | ~420 | thin wrapper over `ShipService`; the binary owns no domain logic |

## Summary

`@ship/cli` is the binary you can invoke from the terminal. Same `ShipService` instance the future MCP server (Phase 8) uses; the CLI just maps argv to method calls and prints the result. No state of its own. No business logic. The Phase 6 dep-direction test already covers the inverse direction (`core` doesn't import `cli`); this phase asserts the forward direction is wired.

This phase exists for one reason:

1. **A binary you can run by hand against a real workdir.** Until Phase 9 dogfoods through the MCP server, the CLI is the user-facing way to drive a `ship`/`status`/`list`/`cancel` end-to-end. It's also the handle Phase 9's e2e test (and the existing `e2e/` skeleton from Phase 4) exercises against a real Cursor SDK.

## Functional requirements

### F1 — `ship ship <docPath>` — start a workflow run

Maps to `ShipService.ship(input)`. Per spec.md § F1.

```
ship ship <docPath> [--workdir <path>] [--repo <name>] [--branch <name>]
                    [--base-ref <ref>] [--worktree-name <name>] [--model <id>]
```

- `<docPath>` (positional, required) — relative or absolute, same shape `ShipService` accepts.
- `--workdir` — defaults to `.` (CWD). Resolved to absolute via `path.resolve` before handing to `ShipService`.
- `--repo` — required for V1; mirrors `ShipInput.repo`. The CLI rejects with a clear "missing --repo" message rather than letting the Zod boundary throw a generic error.
- `--branch`, `--base-ref`, `--worktree-name`, `--model` — optional passthrough.

On terminal status, prints a one-line summary and exits with the matching exit code (see § "Exit codes" below). The full `ShipOutput` JSON goes to stdout when `--json` is set; otherwise it's pretty-printed (status, workflowRunId, summary if present, artifact paths).

### F2 — `ship status <workflowRunId>` — fetch one run

Maps to `ShipService.getRun(id)`.

```
ship status <workflowRunId> [--json]
```

Prints status + phase summary + cursor-run summary. With `--json`, dumps the hydrated `WorkflowRun` shape verbatim. Unknown id exits non-zero (see § "Exit codes").

### F3 — `ship list` — list runs

Maps to `ShipService.listRuns(filter)`.

```
ship list [--repo <name>] [--status <status...>] [--limit <n>] [--json]
```

`--status` accepts repeats (`--status running --status failed`); the CLI passes a string array to the schema. Default limit is 50 (the soft default lives in `core` per Phase 6, not in the CLI). Output: a fixed-width table (id, status, repo, started, ended) when not `--json`.

### F4 — `ship cancel <workflowRunId>` — cancel an in-flight run

Maps to `ShipService.cancelRun(id)`. Idempotent at the service level; the CLI just relays.

```
ship cancel <workflowRunId> [--json]
```

Prints the post-cancel terminal status. With `--json`, dumps the `{ workflowRunId, status }` envelope.

### F5 — Service wiring at startup

The binary entrypoint constructs exactly one `ShipService` per invocation:

```ts
const service = createShipService({
  store:  createStore({ dbPath: resolveDbPath(), clock: () => new Date().toISOString() }),
  cursor: new LocalCursorRunner(),
  fs:     createNodeShipFs(),
  clock:  () => new Date().toISOString(),
  config: { runsDir: resolveRunsDir(), defaultModel: { id: "composer-2" } },
});
```

`resolveDbPath()` and `resolveRunsDir()` derive paths under `<UserConfigDir>/ship/` (e.g. `~/.config/ship/state.db` and `~/.config/ship/runs/` on Linux/macOS). The CLI accepts `--db-path` / `--runs-dir` global flags for tests + power users. See ED-2.

### F6 — Tests via fake-runner-backed service

Smoke tests construct a `ShipService` using `FakeCursorRunner` (via `@ship/test-harness`'s `createServiceFromHarness`) and exercise each subcommand by parsing argv programmatically against the Commander program. No real Cursor SDK calls; no network. Coverage band: same 80/75 as `@ship/test-harness` (CLI is mostly glue).

## Non-functional requirements

- **No imports of `mcp-server`.** Both `cli` and `mcp-server` consume `core` directly.
- **No direct `@cursor/sdk` import.** Only via `@ship/cursor-runner`'s `LocalCursorRunner`. ED-2 of Phase 5 enforces this repo-wide.
- **Single source of truth for command shapes.** Each subcommand's argv parsing lives in one file under `src/commands/`; the binary entrypoint just `program.command(<name>, …)` wires them.
- **Strict TS + lint matching the rest of the repo.** Same eslint cap on params / lines / depth.
- **Coverage threshold:** 80% statements / 75% branches (matches `@ship/test-harness`'s glue band — most of the CLI is parsing + printing, not domain logic).
- **Calibrated comment style.** Per `chore/comment-slim` (PR #6) — short file headers, one-or-two-sentence JSDoc per export.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Argv parser | `commander` | Hand-rolled / yargs / clipanion | Already named in [plan.md § Phase 7](../plan.md). Mature, well-typed, low-surface-area. yargs is heavier; hand-rolled invites bugs. |
| One `ShipService` per invocation | Construct fresh in `bin.ts` | Singleton accessor | The CLI process is short-lived; a fresh service per invocation matches the lifecycle and keeps the seam testable. |
| Subcommand registration | One file per subcommand under `src/commands/`, registered from `bin.ts` | Single `bin.ts` with all wiring | Each subcommand is small but has its own argv shape + output shape; per-file keeps each under the eslint line cap and tests local. |
| Output formatting | Plain text default + `--json` flag | Always JSON / always plain | Plain text for humans at the terminal; JSON for scripts and the e2e harness in Phase 9. The default is the human path. |
| Default `--workdir` | `.` (resolved at parse time) | Required (no default) | Spec.md doesn't require it. Defaulting to CWD matches every other repo CLI's expectation. |
| `--repo` required | CLI-level required flag with friendly error | Let Zod reject with "expected string" | The Zod error reads as an internal-validation message; the CLI's role is to translate to a "missing --repo" suggestion. |
| Exit codes | `0` success, `1` user error, `2` internal error (per spec.md) | Distinguish run-failed / cancelled with their own codes | Spec.md § "Internal interfaces" pins the three-code convention. Failed / cancelled runs exit 0 and surface the run status via stdout's `status` field; shell scripts that need to distinguish can grep that field. See § "Exit codes". |
| Default model handling | Hard-coded `composer-2` in `bin.ts` config | Config file / env override | Spec.md pins composer-2 as the default. Env override (`SHIP_MODEL=…`) lands in V2 if needed. |
| `runsDir` / `dbPath` resolution | `<UserConfigDir>/ship/{state.db, runs/}` via `node:os` | env-driven only | UserConfigDir gives a sensible cross-platform default; `--db-path` / `--runs-dir` overrides handle tests + power users. |
| Smoke tests via Commander program | Construct `program` and parse argv programmatically | Spawn child processes | Spawning is slow + flaky in CI; programmatic parsing exercises the same wiring with no IO overhead. |

## Engineering decisions

### ED-1 — Binary shape

Single entrypoint at `src/bin.ts`. V1 invokes it via `pnpm --filter @ship/cli exec tsx src/bin.ts <args>` (no build step yet); the `ship` shorthand registered via `package.json#bin` lands in V2 alongside the build pass — see § "API boundaries / contracts" for the rationale. The entrypoint:

1. Constructs the `ShipService` (per F5) with production wiring.
2. Builds a Commander `program` with four subcommands.
3. Parses argv. Each subcommand's action calls into the service and writes to stdout/stderr.
4. Maps any thrown error to a stderr message + non-zero exit code (see § "Exit codes").

```ts
// src/bin.ts (sketch)
import { Command } from "commander";
import { createCliService } from "./service.js";
import { registerShipCommand } from "./commands/ship.js";
import { registerStatusCommand } from "./commands/status.js";
// ...

const program = new Command()
  .name("ship")
  .description("Ship V1 — drive ShipService from the terminal");

registerShipCommand(program);
registerStatusCommand(program);
registerListCommand(program);
registerCancelCommand(program);

await program.parseAsync();
```

The `service.ts` wrapper builds a lazy `ShipService` (not constructed until the first command actually needs it) so `ship --help` doesn't hit disk.

### ED-2 — Path resolution: `<UserConfigDir>/ship/`

`resolveDbPath()` returns `<UserConfigDir>/ship/state.db`; `resolveRunsDir()` returns `<UserConfigDir>/ship/runs/`. `<UserConfigDir>` is the platform-specific user-config root (no `ship` suffix); the `/ship/` segment is appended exactly once by the resolver:

- macOS / Linux: `<UserConfigDir>` = `~/.config` → resolved paths `~/.config/ship/state.db` and `~/.config/ship/runs/`.
- Windows: `<UserConfigDir>` = `process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")` → resolved paths `%APPDATA%\ship\state.db` and `%APPDATA%\ship\runs\`.

The `ship` subdirectory is appended once inside `resolveDbPath()` / `resolveRunsDir()`, never inside the platform branches — that avoids the doubled-path failure mode (`...\ship\ship\state.db`) when `APPDATA` is unset and the fallback already terminates with the user's roaming root.

`--db-path` and `--runs-dir` are global flags on `program` that override. Tests pass `--db-path :memory:` to keep state ephemeral.

### ED-3 — Subcommand layout

Each subcommand exports a `register<Name>Command(program: Command): void` function and lives in `src/commands/<name>.ts`. The function attaches the subcommand to `program` and binds its action handler to a service factory passed via the program's context (so tests can inject a fake-runner-backed service).

```ts
// src/commands/ship.ts
import type { Command } from "commander";
import type { ServiceFactory } from "../service.js";

export function registerShipCommand(program: Command, factory: ServiceFactory): void {
  program
    .command("ship <docPath>")
    .option("--workdir <path>", "absolute path of the workspace", ".")
    .requiredOption("--repo <name>", "Tower-registered repo name")
    // ...
    .action(async (docPath: string, opts) => {
      const out = await factory().ship({ workdir: path.resolve(opts.workdir), repo: opts.repo, docPath });
      printShipOutput(out, opts.json);
      process.exit(exitCodeForStatus(out.status));
    });
}
```

### ED-4 — Exit codes

Aligns with spec.md § "Internal interfaces" — `0 success, 1 user error, 2 internal error`. Three-code contract; the run's outcome (succeeded / failed / cancelled) lives in the printed status, not in the exit code.

| Code | Meaning |
|---|---|
| `0` | Success. The CLI ran the command cleanly, regardless of the run's terminal status. `ship ship` resolving to `failed` or `cancelled` still exits 0 — the CLI did its job; the run's outcome is in stdout's `status` field. |
| `1` | User error. Missing required flag, malformed `workflowRunId`, `--workdir` doesn't exist, `docPath` doesn't resolve, doc escapes the workdir, `getRun` / `cancelRun` for an unknown id. Mapped from `WorkdirNotFoundError`, `DocNotFoundError`, `DocPathEscapesWorkdirError`, `null` returns from `getRun`, and Zod errors at the boundary. |
| `2` | Internal error. Anything else thrown out of `ShipService` (store invariant violations, unexpected throws, environment problems like missing `CURSOR_API_KEY` that the CLI couldn't pre-validate). |

The mapping lives in a single `mapErrorToExitCode(err)` helper so the four subcommands stay consistent.

### ED-5 — Output formatting

A small `format.ts` module:

- `printShipOutput(out, json)` — pretty: status line + summary line + artifact paths block. JSON: `JSON.stringify(out, null, 2)`.
- `printRunRow(run)` — used by `status`. Pretty: hydrated `WorkflowRun` rendered as a key/value block. JSON: dump.
- `printRunList(runs)` — fixed-width table (id, status, repo, started, ended). JSON: `{ runs: [...] }`.
- `printCancelOutput({ workflowRunId, status })` — pretty: one-line. JSON: dump.

Pretty output uses simple ASCII formatting only (no ANSI colors in V1) so test snapshots are stable across terminals.

### ED-6 — Lazy service construction

```ts
// src/service.ts
export type ServiceFactory = () => ShipService;

export function createCliService(opts: CliPathOpts): ServiceFactory {
  let cached: ShipService | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const store = createStore({ dbPath: opts.dbPath, clock: nowIso });
    const cursor = new LocalCursorRunner();
    const fs = createNodeShipFs();
    cached = createShipService({ store, cursor, fs, clock: nowIso, config: { runsDir: opts.runsDir, defaultModel: { id: "composer-2" } } });
    return cached;
  };
}
```

Test wiring: the test harness's `createServiceFromHarness(h)` returns a service the test passes through a fake `ServiceFactory`. The Commander program is constructed with that factory; tests parse argv against it.

### ED-7 — `--json` flag

`--json` lives on each subcommand (not the global `program`) because Commander hoists global flags into the subcommand option object only with explicit work. Per-subcommand `option("--json")` keeps each subcommand self-contained.

### ED-8 — Repo-wide isolation test

`packages/cli/test/dep-direction.test.ts` mirrors `core`'s test: `packages/cli/src/**` MUST find zero `from "@ship/mcp-server"` matches. (Importing `@ship/cursor-runner` directly is fine — `LocalCursorRunner` is the production wiring.)

## API boundaries / contracts

The `cli` package exports nothing. It's a thin binary wrapper with no public TS API. The internal modules (`commands/*.ts`, `service.ts`, `format.ts`) are private to the package. V1 invokes it via `pnpm exec tsx src/bin.ts`; the `package.json#bin` shorthand + a build step land in V2 (see ED-1 + the `package.json` shape below).

`package.json` shape:

```json
{
  "name": "@ship/cli",
  "private": true,
  "type": "module",
  "main": "./src/bin.ts",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@ship/core": "workspace:*",
    "@ship/cursor-runner": "workspace:*",
    "@ship/store": "workspace:*",
    "@ship/workflow": "workspace:*",
    "commander": "^12.0.0"
  }
}
```

V1 deliberately omits the `bin` entry: there's no build step yet, so a `bin` pointing at `dist/bin.js` would resolve to a missing file at install time. Local invocation is `pnpm --filter @ship/cli exec tsx src/bin.ts <args>`. The `bin` entry + a build step (probably `tsc --emitDeclarationOnly false` + a small esbuild/tsdown pass) lands in V2 when the CLI is actually published or installed via `npm i -g`.

## Validation plan

Tests live in `packages/cli/src/**/*.test.ts` (unit) plus `packages/cli/test/dep-direction.test.ts` (isolation).

### `ship ship <docPath>` argv → service call

- ✅ Happy path: argv `["ship", "ship", "docs.md", "--workdir", "/tmp/wt", "--repo", "ship"]` → service.ship called with `{ workdir: "/tmp/wt", docPath: "docs.md", repo: "ship" }`; succeeded result → exit 0; pretty output contains workflowRunId + summary.
- ✅ `--json` flag: same argv with `--json` → stdout is parseable JSON matching `ShipOutput` schema.
- ❌ Missing `--repo` → exit 1; stderr contains "missing required option: --repo" or similar.
- ❌ Missing positional `<docPath>` → exit 1; Commander's own error path.
- ❌ Service throws `WorkdirNotFoundError` → exit 1; stderr names the workdir.
- ✅ Service resolves `failed` → exit 0 (CLI ran cleanly); stdout's `status` field is `"failed"`.
- ✅ Service resolves `cancelled` → exit 0; stdout's `status` field is `"cancelled"`.
- ❌ Service throws an unexpected non-typed error → exit 2; stderr names the error.
- ✅ Default `--workdir .` resolves to absolute via `path.resolve(process.cwd())`.

### `ship status <workflowRunId>` argv → service call

- ✅ Existing run: argv `["ship", "status", "wf_..."]` → service.getRun called → pretty output of hydrated row → exit 0.
- ✅ `--json` flag: same argv → stdout is JSON matching `WorkflowRun` schema.
- ❌ Unknown id (service returns null) → exit 1; stderr "not found: <id>".
- ❌ Malformed id (e.g. "garbage") → exit 1; rejected at the schema boundary.

### `ship list` argv → service call

- ✅ No filters → service.listRuns called with empty filter → table output → exit 0.
- ✅ `--repo ship --status running --status failed --limit 25` → service.listRuns called with `{ repo: "ship", status: ["running", "failed"], limit: 25 }`.
- ✅ `--json` flag → stdout is `{ runs: [...] }`.
- ✅ Empty result → table prints header only, no rows; exit 0.

### `ship cancel <workflowRunId>` argv → service call

- ✅ In-flight run: argv `["ship", "cancel", "wf_..."]` → service.cancelRun called → exit 0; pretty output names the post-cancel status.
- ✅ Already-terminal run → service returns the existing terminal status → exit 0; output reflects no-op.
- ❌ Unknown id (service throws) → exit 1.

### Service wiring (`src/service.ts`)

- ✅ `createCliService({ dbPath: ":memory:", runsDir: <tmp> })` returns a factory that lazy-constructs the service.
- ✅ Factory invoked twice returns the same service instance (caching).
- ❌ `dbPath` invalid → throws on first factory call (not on `createCliService`).

### Output formatting (`src/format.ts`)

- ✅ `printShipOutput` pretty mode: deterministic snapshot for a known input.
- ✅ `printShipOutput` json mode: `JSON.parse(...)` round-trips to the input.
- ✅ `printRunList` table renders even rows / headers consistently across statuses.
- ✅ Empty list → header only.

### Repo-wide isolation

- ✅ `packages/cli/src/**` finds zero `from "@ship/mcp-server"` matches.

### Acceptance

- `pnpm --filter @ship/cli test` exits 0.
- `pnpm typecheck` / `lint` / `format:check` from repo root pass.
- `make coverage` passes the 80/75 threshold per package.
- Manual smoke: `pnpm --filter @ship/cli exec tsx src/bin.ts list --json` runs end-to-end against a fresh local SQLite store and prints `{"runs":[]}`.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Commander's typing for action handlers is loose (the `opts` parameter is `unknown`/`any` at the boundary) | Runtime surprises if a flag shape changes | Each subcommand's action handler does an explicit Zod parse on its `opts` immediately, so the typed payload reaches `ShipService`. |
| `<UserConfigDir>/ship/` doesn't exist on first invocation | First `ship ship` fails on `mkdir` | The CLI's startup creates `runsDir` (via `fs.mkdir({ recursive: true })`) before the first `ship` call. `dbPath`'s parent gets the same treatment. |
| Long-running `ship` doesn't observe SIGINT | Stuck CLI that needs `kill -9` | The `ship` action handler installs `process.on("SIGINT", () => abortController.abort())` and threads the signal through to `ShipService` (open Q1). |
| `LocalCursorRunner` requires `CURSOR_API_KEY` | First user invocation fails opaquely | The CLI's startup reads `process.env.CURSOR_API_KEY` and exits with a clear "set CURSOR_API_KEY" message + exit 2 when missing — same code path the runner would have taken, but with a friendlier message. |
| Smoke tests spawn a full Commander parse and may bleed `process.exit` calls into vitest | Test runner aborts mid-suite | The test wires a `program.exitOverride()` so Commander throws instead of calling `process.exit`. The action handlers also use a `cliExit(code)` shim that throws in tests. |
| Output formatting drift between `ship` / `status` / `cancel` | Inconsistent UX | All four subcommands share `format.ts` helpers; snapshot tests pin the pretty-output shape. |

## Open questions

1. **Should `ship ship` accept a `--signal`-style flag for SIGINT cancellation?** Proposed: yes, the action handler installs SIGINT → controller.abort() and passes the signal through to `ShipService.ship`. This requires Phase 6's `ship(input)` to accept an `AbortSignal` (currently in spec.md § Open Q5 as "yes for V1 inside `core`'s API but the MCP tool surface doesn't expose it"). 6c didn't add the signal yet; revisit this in 7's implementation cycle.
2. **`ship list` table output — fixed-width or aligned?** Proposed: fixed-width with a small per-column max (id 32, status 10, repo 24, ts 25). Truncate with ellipsis. Aligns with `gh run list`'s style; tests can snapshot a deterministic width.
3. **`--db-path :memory:` for tests — does the CLI need to expose this, or do tests construct the service factory directly?** Proposed: tests use the factory directly (skipping argv path resolution). The `--db-path` flag still exists for power users + e2e, but isn't on the test-only path.
4. **`--config <path>` flag for a TOML/JSON config file?** Proposed: V2. V1 is "all flags, all the time"; a config file invites scope creep.
5. **Resolved (was: exit-code semantics for failed / cancelled runs).** Aligned with spec.md § "Internal interfaces": `0 success, 1 user error, 2 internal error`. Failed and cancelled runs exit 0; the run's status surfaces in stdout's `status` field. Shell scripts that distinguish can grep that field.

## Implementation plan

After review/approval, implement as **a single PR** in this order:

1. **`packages/cli/{package.json, tsconfig.json, vitest.config.ts}`** — workspace wiring matching Phase 6's pattern. Deps: `@ship/core` / `@ship/cursor-runner` / `@ship/store` / `@ship/workflow` (`workspace:*`); `commander`. The CLI doesn't take a direct dep on `@ship/mcp`; `ShipInput` / `ShipOutput` flow through `@ship/core`'s `ShipService` typing transitively. devDeps: `@ship/test-harness` (`workspace:*`), `@types/node`. `vitest.config.ts` sets the 80/75 coverage threshold.
2. **`src/service.ts` + tests** — `createCliService(opts): ServiceFactory` lazy factory that wires `LocalCursorRunner` + `createNodeShipFs` + `createStore` + `createShipService`. Tests cover lazy caching + invalid `dbPath`.
3. **`src/format.ts` + tests** — pretty + JSON formatters for the four output shapes. Snapshot-style tests pin the pretty output.
4. **`src/commands/ship.ts` + tests** — `registerShipCommand(program, factory)`. Tests parse argv programmatically against a fake-factory-backed program.
5. **`src/commands/status.ts` + tests** — `registerStatusCommand(program, factory)`.
6. **`src/commands/list.ts` + tests** — `registerListCommand(program, factory)`.
7. **`src/commands/cancel.ts` + tests** — `registerCancelCommand(program, factory)`.
8. **`src/bin.ts`** — entrypoint. Constructs the service factory + program, parses argv. Lightly tested (integration smoke).
9. **`packages/cli/test/dep-direction.test.ts`** — `packages/cli/src/**` MUST find zero `from "@ship/mcp-server"` matches.
10. **`make check`** + **`make coverage`** — green.
11. **Mark Phase 7 done in [plan.md](../plan.md).**

Total LOC estimate (per CLAUDE.md weighting): ~280 src + ~280 tests = **420 weighted**. Single PR, comfortably inside the < 500 amazing band.

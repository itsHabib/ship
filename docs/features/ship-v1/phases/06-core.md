# Phase 6 — `packages/core`

Status: design draft, revision 0 (2026-05-09). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-09

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec; § "Component responsibilities" pins what `core` owns. [phases/05-cursor-runner.md](05-cursor-runner.md) shipped the `CursorRunner` interface this phase consumes. [phases/04-qe-sdet.md](04-qe-sdet.md) shipped the `Harness` shape that 6c extends. [phases/03-store.md](03-store.md) shipped the `Store` interface that 6b drives. The PR sizing rule + dep-boundary preference in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:** ~580 src + ~520 tests = **840 weighted LOC** total — over the < 700 ideal band, so **the doc splits into three sub-PRs**, each well under < 500 amazing:

| Sub-PR | Source | Tests | Weighted | Boundary |
|---|---|---|---|---|
| **6a** artifact helpers — NDJSON writer + prompt template + path resolution | ~150 | ~140 | ~220 | dep-free; no `core` types yet |
| **6b** `ShipService` — state machine + `ship` / `getRun` / `listRuns` / `cancelRun` (against fakes) | ~300 | ~260 | ~430 | the meat; consumes 6a's helpers + `@ship/store` + `CursorRunner` interface |
| **6c** harness extension + cross-package scenarios driving full lifecycles through `ShipService` | ~130 | ~120 | ~190 | additive on `@ship/test-harness`; consumes 6b's `ShipService` + `FakeCursorRunner` |

6a and 6b can be drafted in parallel (no shared types until the integration step inside 6b). 6c serializes after both. Total Phase 6 land: 3 PRs.

## Summary

`@ship/core` is the workflow brain. It owns the state machine, the artifact-write logic, and the rendered implementation prompt template. Other packages (`cli`, `mcp-server`) consume `ShipService` instances; this package never imports them. The `CursorRunner` interface comes in from `@ship/cursor-runner` (Phase 5); the SDK never appears here.

This phase exists for two reasons:

1. **The state machine has to live in code, not a prompt.** Spec.md § NFR mandates deterministic state transitions; the LLM produces the implementation, not the verdict on whether the workflow is done. `ShipService` is where that determinism lives.
2. **Single seam between Ship and external state.** Persistence, cursor execution, filesystem artifacts, clock — all four collaborators come in through one factory. Tests substitute fakes; production wires the real ones. Without this seam, every consumer (CLI, MCP server, future cloud orchestrator) would have to reproduce the wiring.

## Functional requirements

### F1 — `createShipService({ store, cursor, fs, clock, config })` factory

The single constructor. Returns a `ShipService` bound to the supplied collaborators. No global state; tests construct as many as they need.

```ts
export interface ShipServiceConfig {
  /** Absolute path of the artifacts directory (`<UserConfigDir>/ship/runs/`). */
  readonly runsDir: string;
  /** Default model when input.model is omitted. */
  readonly defaultModel: ModelSelection;
  /** Optional MCP servers passed through to every `cursor.run()` call. */
  readonly mcpServers?: Record<string, McpServerConfig>;
}

export interface ShipServiceDeps {
  readonly store: Store;
  readonly cursor: CursorRunner;
  readonly fs: ShipFs;
  readonly clock: () => string;
  readonly config: ShipServiceConfig;
}

export function createShipService(deps: ShipServiceDeps): ShipService;
```

`ShipFs` is a small interface (`writeFile`, `mkdir`, `readFile`, `createWriteStream`) over `node:fs/promises` + `node:fs`. DI'd so tests can substitute an in-memory implementation. See ED-3.

### F2 — `ship(input)` lifecycle

Per spec.md § F1. The single end-to-end happy-path:

1. Validate `input.workdir` exists (`fs.stat`); validate `input.docPath` resolves to a readable file inside it (symlink-escape rejection).
2. Mint `workflowRunId` via `newWorkflowRunId()`.
3. Resolve the artifact dir: `${config.runsDir}/${workflowRunId}/`. Create it via `fs.mkdir({ recursive: true })`.
4. Read the task doc from `<workdir>/<docPath>`. Snapshot it as `<artifactDir>/task-doc.md`.
5. Render the implementation prompt (template + task doc + workdir metadata). Persist as `<artifactDir>/prompt.md`.
6. `store.createWorkflowRun({ id, repo, docPath, status: "pending", baseRef, worktree, policy })`.
7. Mint `phaseId` via `newPhaseId()`. `store.appendPhase({ id, workflowRunId, kind: "implement", status: "running", startedAt, inputJson })`.
8. `store.updateWorkflowRunStatus(id, "running")`.
9. Open the NDJSON writer at `<artifactDir>/events.ndjson` (append mode).
10. Call `cursor.run({ cwd: workdir, prompt, model, mcpServers, agentName: "ship/" + workflowRunId, signal, onEvent: (ev) => ndjson.write(ev) })`.
11. Mint `cursorRunId` via `newCursorRunId()`. `store.recordCursorRun({ id, workflowRunId, agentId, runtime: "local", model, status: "running", startedAt, artifactsDir })`.
12. Hold the handle in the in-process active-run registry keyed by `workflowRunId` (see ED-2).
13. `await handle.result`. On resolve: persist as `<artifactDir>/result.json`; extract `summary` field as `<artifactDir>/summary.md`.
14. Map terminal status (`succeeded` / `failed` / `cancelled`). Update phase + cursor-run + workflow-run rows accordingly. Close the NDJSON writer.
15. Remove the handle from the active-run registry.
16. Return `ShipOutput` (workflowRunId, status, worktree, cursorRun summary, artifact paths).

The MCP tool returns once `ship` resolves. Streaming responses are V2.

### F3 — `getRun(id)`

Forwards to `store.getRun(id)` and returns the hydrated `WorkflowRun | null`. No business logic; the store does the hydration.

### F4 — `listRuns(filter)`

Forwards to `store.listRuns(filter)`. Repo + status filtering happens in SQL; ordering + pagination are the store's concern.

### F5 — `cancelRun(id)`

Per spec.md § F4. Idempotent.

1. If a handle exists in the active-run registry for `id`, call `handle.cancel()`. The handle's existence is the source of truth for "is this run in-flight in THIS process."
2. Regardless of step 1, call `store.cancelRun(id)`. The store's cancel is idempotent (Phase 3) — it transitions `pending` / `running` → `cancelled` and no-ops on terminal rows.
3. Return `{ workflowRunId: id, status: "cancelled" | <current terminal status if already done> }`.

If the run was started by a different process (e.g. a previous Ship instance, since restarted), step 1 finds nothing and step 2 still updates the row — the in-flight Cursor run on the abandoned process becomes orphaned. V1 accepts; durable cancel across restarts is V2.

### F6 — Artifact writers (lands in 6a)

Three small modules under `packages/core/src/artifacts/`:

- **`ndjson.ts`** — `createNdjsonEventWriter(targetPath: string): EventWriter` wrapping `fs.createWriteStream` in append mode. Exposes `write(event: SDKMessage)`, `flush()`, `close()`. Errors propagate via the stream's `error` event; consumers handle. (Moved from `cursor-runner` per the cycle-1 decision in the Phase 5 doc — generic JSON-lines append helper, only call site is `core`.)
- **`paths.ts`** — `resolveRunArtifactsDir(runsDir, workflowRunId): string` and the per-artifact filename constants (`prompt.md`, `task-doc.md`, `events.ndjson`, `result.json`, `summary.md`).
- **`prompt-template.ts`** — `renderImplementationPrompt({ taskDoc, repo, worktreePath, branch, baseRef }): string`. Pure function; the template lives as a TS template literal here, NOT in a markdown file consumers might edit.

### F7 — State-machine enforcement

State transitions go through `@ship/workflow`'s `canTransition()` / `isTerminal()` helpers. `ShipService` never writes a status without first verifying the transition is allowed. Invalid transitions throw — they're internal-invariant violations, not caller errors.

The state row is the source of truth for terminal state. The in-process handle is a side channel for cancel coordination only — if the handle and the row disagree, the row wins.

## Non-functional requirements

- **No imports of `cli` or `mcp-server`.** They depend on `core`; not the reverse.
- **No direct `@cursor/sdk` import.** Only `@ship/cursor-runner`'s interface. ED-2 of Phase 5 enforces this repo-wide.
- **Synchronous state machine.** State transitions don't wait on disk I/O completing — the row is updated, then the artifact is written. (Crash mid-write is documented in Risks.)
- **Idempotent `cancelRun`.** Repeated calls do not flip terminal rows back to running, do not throw, do not double-call `handle.cancel`.
- **Strict TS + lint matching the rest of the repo.** Same eslint cap on params / lines / depth.
- **Coverage threshold:** 90% statements / 85% branches per the runtime-touching band (matches `@ship/store`, `@ship/cursor-runner`).
- **Calibrated comment style.** Per `chore/comment-slim` (PR #6) — short file headers, one-or-two-sentence JSDoc per export, no cycle-history narration, no design-doc duplication. Phase 6 follows that bar from day one.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Cancel coordination | In-process active-run registry (Map<workflowRunId, CursorRunHandle>) | Persist handle metadata to the store and reach across processes | Cross-process cancel needs durable handles which the SDK doesn't expose. V1 accepts the single-process limitation per spec.md § NFR. |
| Filesystem access | DI'd `ShipFs` interface over `node:fs` | Direct `node:fs` import in `core` | Tests need to substitute an in-memory FS so they don't hit disk; the real impl is a 30-line wrapper. Same shape every other DI'd collaborator uses. |
| Prompt template location | TS template literal in `core/src/artifacts/prompt-template.ts` | Markdown file under `core/templates/` loaded at runtime | The template IS the contract between Ship and the agent; it must version with the code, not be a side-channel a user can edit by accident. |
| Artifact dir structure | `<runsDir>/<workflowRunId>/{prompt,task-doc,events,result,summary}` | Per-package subdirs or per-phase subdirs | Spec.md § ED-4 already pins this. V1 has one phase, so flat is fine. |
| Active-run registry implementation | Plain `Map<string, ActiveRun>` on the `ShipService` instance | A separate `RunRegistry` class with its own tests | The registry has no logic worth testing in isolation — `ship()` adds, `cancelRun()` reads, `ship()` removes on terminal. Inlining keeps the surface tight. |
| `ShipFs` granularity | One interface with the four methods we need | Wrap each `node:fs` call in its own DI'd factory | `ShipFs` is a tight cluster of methods that always vary together (you swap real-fs for memory-fs as a unit). Splitting buys nothing. |
| Default model handling | `core` resolves the default from `config.defaultModel` if `input.model` is undefined | Each runner exposes its own default | `core` already knows the user's config (it was passed at construction); pushing the default into the runner forces every runner to know about Ship's config shape. |
| State-machine helpers | Reuse `canTransition` / `isTerminal` from `@ship/workflow` | Re-implement in `core` because it owns the semantics | The helpers ARE the semantics. Owning them in `workflow` keeps every consumer (`store`, `core`, future `mcp-server` for resource shape) on the same definition. |

## Engineering decisions

### ED-1 — `ShipService` is a class-flavored object, constructed once per process

`createShipService(deps)` returns a frozen object with the four methods bound to a closure over `deps`. No `new ShipService(...)`; no inheritance. Same factory shape `@ship/store`'s `createStore(...)` uses. The CLI and MCP server each construct one at startup; tests construct one per `describe` block.

### ED-2 — Active-run registry: in-process `Map<workflowRunId, ActiveRun>` on the closure

`ActiveRun` carries the `CursorRunHandle` plus an `AbortController` that `core` owns (NOT `input.signal` from the caller — that one composes by listening to both). Adding to the map happens at step 12 of F2; removing happens at step 15, regardless of terminal status. `cancelRun(id)` looks up the map, calls `activeRun.controller.abort()` (which the runner's signal listener picks up), then falls through to the store cancel.

The map is **not** persisted. A process restart loses every in-flight run's handle but preserves the row state — those orphaned runs surface as `running` rows whose actual SDK run is no longer reachable; spec.md § NFR documents this limitation.

### ED-3 — `ShipFs` interface over `node:fs/promises` + `node:fs`

Methods (only what `core` actually calls):

```ts
export interface ShipFs {
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  /** Returns a Node `WritableStream` — not a generic `Writable` — so the NDJSON writer can use `.write()` / `.end()` directly. */
  createWriteStream(path: string, opts: { flags: "a" }): NodeJS.WritableStream;
}
```

Production wiring: a 20-line `createNodeShipFs()` factory in `core/src/fs/node.ts` that delegates to `node:fs/promises` + `node:fs`. Tests construct a `createMemoryShipFs()` (also in this package) backed by a `Map<string, string>`.

### ED-4 — NDJSON writer lives in `core`, not `cursor-runner`

Decided in the Phase 5 design-doc cycle. The writer doesn't import `@cursor/sdk` and `core` is its only call site. Lives in `core/src/artifacts/ndjson.ts`.

### ED-5 — Prompt template is a TS file, version-controlled with the code

`core/src/artifacts/prompt-template.ts` exports `renderImplementationPrompt(input): string` whose body is the template from spec.md § "Implementation prompt template" with the input fields interpolated. Tests pin the rendered output for a known input (golden-file style).

### ED-6 — Symlink-escape rejection on `docPath`

`docPath` is resolved against `workdir` via `path.resolve(workdir, docPath)`, then both paths run through `fs.realpath` (when the file exists). If the realpath of the doc isn't a prefix-child of the realpath of the workdir, throw `DocPathEscapesWorkdirError`. Per spec.md § Risks. Implemented in `core/src/validate.ts`.

### ED-7 — Error policy

Thrown errors map cleanly:

| Error | Source | Policy |
|---|---|---|
| `WorkdirNotFoundError` | `fs.stat(input.workdir)` rejects | `ship()` rejects; no row created |
| `DocNotFoundError` | doc resolves but isn't readable | `ship()` rejects; no row created |
| `DocPathEscapesWorkdirError` | symlink-escape check fails | `ship()` rejects; no row created |
| `MissingApiKeyError` (from runner) | `cursor.run()` rejects with this | `ship()` rejects; no row created (we threw before any store write that mattered) |
| `CursorRunFailedError` (from runner) | `Agent.create` / `agent.send` threw | Update phase + workflow → `failed` with `errorMessage`; persist what artifacts we have; resolve `ship()` with `ShipOutput` carrying status `failed` |
| `RunResult.status === "error"` | The run did exist; agent reported error | Same as above — phase + run end `failed`; `ship()` resolves with `ShipOutput` |
| Store mutator throws (`PhaseNotFoundError`, etc.) | Internal-invariant violation; should never fire on the happy path | Propagate; this is a `core` bug |
| `fs` write fails after the run completed | E.g. disk full when persisting `result.json` | Update workflow → `failed` with `errorMessage`; surface via `ShipOutput`. Best-effort: `events.ndjson` may already be on disk |

The split between "rejects" and "resolves with `failed`" follows the same intuition as Phase 5's `CursorRunFailedError` vs `result.status: "failed"` distinction — pre-run failures throw; post-run-creation failures surface as terminal status.

## API boundaries / contracts

The public surface re-exported from `packages/core/src/index.ts`:

```ts
// === service.ts ===
export type { ShipService, ShipServiceConfig, ShipServiceDeps } from "./service.js";
export { createShipService } from "./service.js";

// === fs/index.ts ===
export type { ShipFs } from "./fs/index.js";
export { createNodeShipFs, createMemoryShipFs } from "./fs/index.js";

// === errors.ts ===
export {
  WorkdirNotFoundError,
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  ArtifactWriteFailedError,
} from "./errors.js";
```

The `ShipService` interface:

```ts
export interface ShipService {
  ship(input: ShipInput): Promise<ShipOutput>;
  getRun(workflowRunId: string): Promise<WorkflowRun | null>;
  listRuns(filter: ListWorkflowRunsInput): Promise<WorkflowRun[]>;
  cancelRun(workflowRunId: string): Promise<{ workflowRunId: string; status: WorkflowStatus }>;
}
```

`ShipInput` / `ShipOutput` come from `@ship/mcp` (already shipped in Phase 2). `core` doesn't redefine them.

### Stability promise (within V1)

The four `ShipService` methods are the contract every `cli` / `mcp-server` handler codes against. Adding optional fields to `ShipServiceConfig` is fine; renaming or removing methods updates every consumer in the same commit.

## Validation plan

Tests live in `packages/core/src/**/*.test.ts` plus the harness scenarios extension under `packages/test-harness/scenarios/`.

### `createShipService` + dep injection

- ✅ Constructed with all four deps + config; returns an object with the four methods.
- ✅ Multiple instances are independent (separate active-run registries).
- ❌ Missing required dep at construction time → throws (helps catch wiring bugs).

### `ship()` lifecycle (against `FakeCursorRunner` + `createMemoryShipFs`)

- ✅ Happy path: pending → running → succeeded; rows + artifacts written in order; `ShipOutput` populated.
- ✅ Status mapping: scripted `failed` result → workflow status `failed` + errorMessage on the run row.
- ✅ Status mapping: scripted `cancelled` result → workflow status `cancelled`.
- ❌ Workdir doesn't exist → `WorkdirNotFoundError`; no row created.
- ❌ Doc doesn't exist → `DocNotFoundError`; no row created.
- ❌ Doc path resolves outside workdir (symlink) → `DocPathEscapesWorkdirError`; no row created.
- ❌ `CursorRunFailedError` from runner → workflow ends `failed` with errorMessage; `events.ndjson` may be empty but exists; `result.json` not written.
- ✅ Active-run registry: handle is added before `await handle.result`, removed after.
- ✅ Artifact paths match `<runsDir>/<workflowRunId>/<filename>` for all five files.
- ✅ `prompt.md` content matches a golden-file render of the template.
- ✅ `events.ndjson` contains one JSON-line per event in stream order.
- ✅ Crash mid-stream (FakeCursorRunner errors) → workflow ends `failed`; whatever was streamed survives in `events.ndjson`.

### `getRun()` + `listRuns()`

- ✅ Forward to `store.getRun` / `store.listRuns` unchanged. Single test each.

### `cancelRun()` (against `FakeCursorRunner` w/ `cancelBehavior: "complete"`)

- ✅ Cancel an in-flight run → handle.cancel() invoked → workflow ends `cancelled`.
- ✅ Cancel a run not in this process's registry but still `running` in the store → store row transitions to `cancelled`; no SDK call.
- ✅ Cancel a terminal run → no-op; current status returned.
- ✅ Idempotent: two cancels in a row are safe.

### Artifact helpers (6a, can land before `ShipService`)

- ✅ `createNdjsonEventWriter`: one line per write, ordering preserved, `close()` idempotent, error surfaces via stream `error` event.
- ✅ `resolveRunArtifactsDir`: composes `runsDir + workflowRunId` correctly on POSIX + Windows path separators.
- ✅ `renderImplementationPrompt`: golden-file output for a sample task doc + workdir metadata.

### `ShipFs` impls (6a)

- ✅ `createMemoryShipFs`: round-trips writes; `mkdir({ recursive: true })` is a no-op; `createWriteStream` returns a writable that buffers into the in-memory map.
- ✅ `createNodeShipFs`: smoke-tested against a tmpdir.

### Cross-package scenarios (6c, lives in `@ship/test-harness/scenarios/`)

- ✅ `core-happy-path.scenario.test.ts`: harness wires `FakeCursorRunner` into `createShipService(...)`; scenario calls `ship()` then `getRun()` then `listRuns()`; asserts on hydrated row + every artifact file.
- ✅ `core-cancel-mid-flight.scenario.test.ts`: scripted long-delay run; scenario fires `cancelRun()` mid-stream; asserts terminal status + partial events.
- ✅ `core-doc-validation.scenario.test.ts`: invalid `docPath` (escape); asserts no row created.
- ✅ Existing 5 storage-level scenarios continue to pass (additive harness change).

### Acceptance

- `pnpm --filter @ship/core test` exits 0.
- `pnpm typecheck` / `lint` / `format:check` from repo root pass.
- `make coverage` passes the 90/85 threshold per package.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Active-run registry leak (run crashes such that the `finally` in `ship()` doesn't fire — process kill, OOM) | Stale `running` rows whose handles are gone | At process startup, `core` doesn't trust running rows; `cli`'s `list` shows them with a "stale" hint. V2 adds a heartbeat. Acceptable for V1. |
| Artifact write fails mid-flight (events.ndjson on a full disk) | Workflow row says `running` while the underlying run is dead | NDJSON writer surfaces stream errors; `core` updates the row to `failed` with errorMessage. Happy-path artifacts written *after* terminal still need the same handling — wrap in try/catch around the writes inside the terminal-finalization block. |
| `fs.realpath` succeeds but the resolved path is in a hostile location (race condition) | Symbolic-link race between the realpath check and the read | V1 accepts. The threat model is "user accident" not "adversarial workdir". Documented. |
| Prompt template diverges from spec.md | Code and design doc say different things | Golden-file test in 6a + spec.md citation in the test's docblock. Edits update both. |
| `core` accidentally couples to `cli` or `mcp-server` | Inverted dep graph; consumers can't be tested independently | Repo-wide grep test (analogous to ED-2 in Phase 5): `packages/core/src/**` MUST find zero `from "@ship/cli"` / `from "@ship/mcp-server"` matches. |
| In-process registry doesn't survive restart | Mid-flight runs become orphans the user has to clean up manually | V1 acceptable per spec.md § NFR. V2 with cloud Cursor runtime fixes durable runs by definition. |
| `ShipServiceConfig.runsDir` doesn't exist at construction time | First `ship()` call fails on `mkdir` | Either `createShipService` validates + creates `runsDir` eagerly, or `ship()` does it on first call. Open Q3. |

## Open questions

1. **Where does `runsDir` come from in V1?** Proposed: `<UserConfigDir>/ship/runs/` resolved at `cli` / `mcp-server` startup time, passed in as `config.runsDir`. `core` itself never reads env vars or guesses paths. (Symmetric with `dbPath` in `@ship/store`.)
2. **Do we eagerly create `runsDir` in `createShipService`, or lazily on first `ship()`?** Proposed: lazily, in `ship()` step 3, since that's the only method that needs it. `getRun` / `listRuns` / `cancelRun` are read-only / row-only.
3. **`task-doc.md` snapshot — exact bytes or normalized?** Proposed: exact bytes from `<workdir>/<docPath>`. No CRLF normalization, no trailing-newline insertion. The snapshot is for forensics; mutation distorts it.
4. **`summary.md` extraction strategy.** Per spec.md § Open Q5 (resolved 2026-05-06): `RunResult.result` IS the final assistant text — write it verbatim as `summary.md`. No structured-field parsing. Implemented as a one-line copy.
5. **Should `ship()` accept an `AbortSignal`?** Currently spec.md says no (single MCP call returns when done). Proposed: yes for V1 inside `core`'s API but the MCP tool surface doesn't expose it; `cli` will use it for SIGINT (`process.on("SIGINT", () => signal.abort())`). The signal funnels through to `cursor.run({ signal })`.
6. **What does `ship()` return for `summary` if the run failed before producing one?** Proposed: `summary` is omitted from `ShipOutput` (matches `CursorRunResult.summary` being optional). `errorMessage` carries the failure reason instead.

## Implementation plan

After review/approval, implement as **three PRs** in this order. 6a + 6b are independent and can be drafted in parallel; the integration step inside 6b waits for 6a's helpers.

### 6a — artifact helpers + `ShipFs` interface

1. **`packages/core/{package.json, tsconfig.json, vitest.config.ts}`** — workspace wiring matching Phase 5's pattern. Deps: `@ship/workflow`, `@ship/mcp`, `@ship/store`, `@ship/cursor-runner` (`workspace:*`); devDeps: `@types/node`. `vitest.config.ts` sets the 90/85 coverage threshold.
2. **`src/fs/index.ts` + `src/fs/node.ts` + `src/fs/memory.ts` + tests** — `ShipFs` interface, `createNodeShipFs`, `createMemoryShipFs`. Both impls covered.
3. **`src/artifacts/ndjson.ts` + tests** — `createNdjsonEventWriter` + `EventWriter` type.
4. **`src/artifacts/paths.ts` + tests** — `resolveRunArtifactsDir` + filename constants.
5. **`src/artifacts/prompt-template.ts` + tests** — `renderImplementationPrompt` + golden-file test.
6. **`src/index.ts`** — barrel for what 6a publishes (subset of the full surface; 6b adds the rest).
7. **`make check`** + **`make coverage`** — green.

### 6b — `ShipService` + state machine

1. **`src/errors.ts`** — `WorkdirNotFoundError`, `DocNotFoundError`, `DocPathEscapesWorkdirError`, `ArtifactWriteFailedError`.
2. **`src/validate.ts` + tests** — symlink-escape resolver, workdir/doc existence checks.
3. **`src/service.ts` + tests** — `ShipService` interface, `createShipService` factory, the four methods. SDK + store + fs all faked. Tests cover the validation plan's "ship() lifecycle", "cancelRun()", state-mapping, active-run registry contracts.
4. **Repo-wide isolation test** — `packages/core/src/**` MUST find zero `from "@ship/cli"` / `from "@ship/mcp-server"` matches. Lives at `packages/core/test/dep-direction.test.ts`.
5. **`src/index.ts`** — extend the barrel with `ShipService` + `createShipService` + errors.
6. **`make check`** + **`make coverage`** — green.

### 6c — harness extension + cross-package scenarios

1. **`packages/test-harness/src/harness.ts`** — extend `Harness` with `cursor: FakeCursorRunner` (additive; existing scenarios keep working) and a helper `createServiceFromHarness(h): ShipService` that wires the harness's store + cursor + an in-memory `ShipFs` + the harness clock + a config with a tmp `runsDir`.
2. **`scenarios/core-happy-path.scenario.test.ts`** — full-stack `ship()` → `getRun()` against the fake.
3. **`scenarios/core-cancel-mid-flight.scenario.test.ts`** — long-delay scripted run; `cancelRun()` mid-stream.
4. **`scenarios/core-doc-validation.scenario.test.ts`** — invalid `docPath` rejected.
5. **`make check`** + **`make coverage`** — green.
6. **Mark Phase 6 done in [plan.md](../plan.md).**

Total LOC estimate (per CLAUDE.md weighting): ~580 src + ~520 tests = **840 weighted**. Sub-PR plan keeps each PR under 500 amazing.

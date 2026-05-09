# Phase 5 — `packages/cursor-runner`

Status: design draft, revision 0 (2026-05-09). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-09

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec; § "Component responsibilities" and § "Internal interfaces" pin the runner's contract. [docs/cursor-sdk-typescript.md](../../../cursor-sdk-typescript.md) is the SDK reference, with the **load-bearing § "Spike findings"** at the bottom — every "what does the SDK actually do" claim in this doc cites that section, not the reference. [phases/04-qe-sdet.md](04-qe-sdet.md) shipped the `@ship/test-harness` consumer that this package's `FakeCursorRunner` plugs into. The PR sizing rule in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:** ~540 src + ~380 tests = **730 weighted LOC** (just over the < 700 ideal band; well under < 1000 stretch).

The honest split — preferred: **land as 2 PRs**, both well under 500 amazing:

| Sub-PR | Source | Tests | Weighted |
|---|---|---|---|
| **5a** scaffold + types + NDJSON writer + `FakeCursorRunner` (no `@cursor/sdk` dep) | ~270 | ~200 | ~370 |
| **5b** `LocalCursorRunner` (the `@cursor/sdk` impl) + integration with the harness | ~270 | ~180 | ~360 |

5a is the safe surface — pure types, file I/O, and the scriptable fake. 5b adds the one new external dep in the package (`@cursor/sdk`) and the Node-process-bound local runtime; reviewers can focus on SDK shape correctness without the noise of the rest of the package.

Single-PR fallback (~730 weighted) is acceptable if reviewers prefer one full picture; flagged in the implementation plan.

## Summary

A single TypeScript package — `@ship/cursor-runner` — that owns every line of code in the monorepo that imports `@cursor/sdk`. The SDK is otherwise invisible to Ship; consumers (`core`, eventually `mcp-server`) talk to a small, substrate-agnostic `CursorRunner` interface.

V1 ships one implementation: `LocalCursorRunner`, which calls `Agent.create({ local: { cwd } })` and streams events out via a callback. V2 will add `CloudCursorRunner` behind the same interface — substrate-agnosticism is a day-one shape, not a retrofit. A `FakeCursorRunner` ships from this package for downstream tests; `core`'s tests + `@ship/test-harness` scenarios use the fake (no API key, no SDK calls).

This phase exists for two reasons:

1. **Validation seam.** Spec.md calls the SDK "the riskiest assumption in the entire Ship project." Phase 0's spike validated the basic shape on a 67s-long happy-path run; this phase moves those findings into production code, against the constraints `core` actually puts on it (cancellation timing, NDJSON serialization, error normalization).
2. **Isolation.** Cursor SDK churn — new event types, schema changes on `tool_call.args`, new `RunStatus` values — touches one file. The V1 spec.md mandates this seam; the package enforces it.

## Functional requirements

### F1 — `CursorRunner` interface

The contract `core` codes against. Substrate-agnostic by construction:

```ts
export interface CursorRunner {
  run(input: CursorRunInput): Promise<CursorRunHandle>;
}

export interface CursorRunInput {
  cwd: string;                                  // workdir the caller supplied
  prompt: string;                               // rendered implementation prompt (built by core)
  model: ModelSelection;                        // from @ship/workflow
  mcpServers?: Record<string, McpServerConfig>;
  agentName?: string;                           // becomes the SDK's agent name; useful for Agent.list filtering
  signal?: AbortSignal;                         // wired to run.cancel()
  onEvent: (event: SDKMessage) => void;         // called for every stream message; consumers persist
}

export interface CursorRunHandle {
  agentId: string;                              // SDK agent id (e.g. agent-<uuid>)
  runId: string;                                // SDK run id (e.g. run-<uuid>)
  result: Promise<CursorRunResult>;             // resolves on terminal status
  cancel: () => Promise<void>;                  // idempotent
}

export interface CursorRunResult {
  status: "succeeded" | "failed" | "cancelled";
  summary?: string;                             // RunResult.result verbatim (see Spike § Surprises)
  durationMs: number;
  model?: ModelSelection;                       // may be absent on resume (SDK gotcha)
  branches?: Array<{ repoUrl: string; branch?: string; prUrl?: string }>;  // empty for local; populated for cloud (V2)
  errorMessage?: string;
}
```

Substrate selection (local vs cloud) is NOT on this interface. The `LocalCursorRunner` implementation is the V1 default; V2's cloud impl is a separate class with the same interface. Callers pick the implementation; the runner type doesn't carry a `runtime` field.

### F2 — `LocalCursorRunner` implementation

Sole importer of `@cursor/sdk` in the monorepo. Behavior:

1. Calls `Agent.create({ apiKey, model, local: { cwd }, mcpServers, name: agentName })`. `apiKey` is read from `process.env.CURSOR_API_KEY` and never accepted as an input field — see ED-1.
2. Calls `agent.send(prompt)`. Captures `agent.agentId` and `run.id` for the handle.
3. Begins `for await (const ev of run.stream())`, calling `onEvent(ev)` for each event.
4. Wires `signal.onabort` to `run.cancel()`. The handle's `cancel()` does the same; both are idempotent (a second call after the SDK has terminated is a no-op).
5. After the stream terminates, awaits `run.wait()` to capture the structured `RunResult`.
6. Maps `RunResult` → `CursorRunResult`:
   - `RunResult.status === "finished"` → `"succeeded"`
   - `"error"` → `"failed"` (`errorMessage` populated)
   - `"cancelled"` → `"cancelled"`
   - `summary` ← `RunResult.result` verbatim (per Spike § Surprises — no event-scan parse needed)
   - `durationMs` ← `RunResult.durationMs ?? 0` (`0` is valid for instant errors)
   - `branches` ← `RunResult.git?.branches ?? []` (always empty for local; cloud will populate)
7. Disposes the agent (`agent[Symbol.asyncDispose]()`) before resolving the result.

The implementation does NOT:
- Block waiting for a `system` event to fire (Spike § Surprises observed none in the happy-path run; the de-facto start signal is the first `status: "RUNNING"`).
- Synthesize events the SDK didn't emit.
- Parse `tool_call.args` / `tool_call.result` (Spike § Confirmed: those are unstable). The envelope (`type`, `call_id`, `name`, `status`) is stable; the payloads pass through to `onEvent` as opaque.

### F3 — NDJSON event writer

A small helper `createNdjsonEventWriter(targetPath: string): EventWriter` that wraps a `fs.createWriteStream` in `flags: "a"` mode and:

- Serializes each `SDKMessage` to one `JSON.stringify(event) + "\n"` line.
- Buffers writes via the stream's own write-queue (no manual batching in V1; revisit if Spike v2 shows event volume warrants it — Spike v1 saw 119 events over 67s, ~2/sec; not hot).
- Exposes `write(event)`, `flush()`, `close()`.
- Errors during write (disk full, permission denied) propagate via the stream's `error` event; consumers handle.

The writer is a thin wrapper, not a hidden batcher. `core` constructs it with the run's `events.ndjson` path and passes its `.write` as `onEvent`.

### F4 — Cancellation

Cancel is reachable from two paths, both idempotent:

- **`signal: AbortSignal`** — caller passes one; the runner attaches `signal.onabort` to call `run.cancel()`. Used by `core` to wire SIGINT or per-run timeout.
- **`handle.cancel()`** — the runner exposes a method on the returned handle. Useful in tests and for future cancel-by-id paths from the MCP server.

Per spike § Untested: cancellation was NOT exercised in spike #1. Phase 5 is where we exercise it. Validation plan covers the timing assertion (run terminates within 5s of cancel; partial output is preserved per the SDK doc).

### F5 — `FakeCursorRunner` for downstream tests

Exported from the same package (under `cursor-runner/test/fake.ts` per the existing convention). Shape:

```ts
export interface FakeCursorScript {
  events: SDKMessage[];                              // emitted in order via setImmediate
  result: CursorRunResult;                           // resolved by handle.result
  cancelBehavior?: "complete" | "ignore" | "throw"; // how cancel() interacts with the script
  delayMsBetweenEvents?: number;                     // default 0 (synchronous-ish)
}

export class FakeCursorRunner implements CursorRunner {
  constructor(opts?: { defaultScript?: FakeCursorScript });
  enqueue(script: FakeCursorScript): void;           // queue per-call scripts
  run(input: CursorRunInput): Promise<CursorRunHandle>;
}
```

A scenario test calls `enqueue(...)` once per expected `run()` call; the fake pops scripts in FIFO order. If `run()` is called more times than scripts were enqueued and no `defaultScript` was provided, the fake throws — caught by tests so misconfigured scenarios fail loud.

`@ship/test-harness` extends its `Harness` interface with an optional `cursor: FakeCursorRunner` property in Phase 5b; existing scenarios (the 5 from Phase 4) keep working unchanged.

## Non-functional requirements

- **Sole `@cursor/sdk` importer.** A repo-wide grep test (`packages/*/src/**/*.ts` minus `packages/cursor-runner/**`) MUST find zero `from "@cursor/sdk"` matches. Locks the seam.
- **Zero side effects on import.** No SDK calls, no `Agent.create`, no fs writes at module load.
- **No API key in any persisted struct.** `LocalCursorRunner` reads `process.env.CURSOR_API_KEY` at `run()` time and immediately passes it to `Agent.create`. The key never lives on `this`, on the `CursorRunInput`, in any logged event, or in the NDJSON archive.
- **NDJSON writer is fault-isolated.** A write error after the stream has started must NOT abort the SDK run — `core` decides whether to proceed or cancel. Phase 5 surfaces the error via the writer's stream events and the consumer hooks.
- **Strict TS + lint matching the rest of the repo.** `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`. Same eslint cap on params / lines / depth.
- **Coverage threshold:** 90% statements / 85% branches per the existing band for runtime-touching code (matches `@ship/store`). Set in this package's `vitest.config.ts`.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Substrate API shape | One `CursorRunner` interface; one impl per runtime | `runtime: "local" \| "cloud"` field on `CursorRunInput` | Polymorphism beats a discriminator string. The cloud impl will need different state (env vars, repos, PR autocreate) than local; folding both behind one type would force union-typed input. |
| API key plumbing | Env-only, read at `run()` time | Accept on `CursorRunInput` | Spec.md § Risks: "The `cursor-runner` package never accepts a key in any persisted struct." Env-only enforces this at the type level. |
| Event surfaces | Pass `SDKMessage` to `onEvent` verbatim | Normalize into a Ship-internal event union | Spike confirmed envelope shape is stable; payloads (`tool_call.args`/`result`) are opaque anyway. Normalization adds churn without adding stability. |
| Stream consumption | `for await ... of run.stream()` | `onDelta` callback | `stream()` is the documented event surface; `onDelta` is finer-grained and gives token deltas. V1 doesn't need token-level resolution. |
| NDJSON batching | None in V1 | Time- or count-batched writer | Spike v1 saw ~2 events/sec; the OS write buffer absorbs that. Premature optimization. Documented in F3 as a revisit if Spike v2 shows volume. |
| Cancellation surface | Both `AbortSignal` and `handle.cancel()` | One or the other | Signal is composable with timers; `handle.cancel()` is what the MCP `cancel_workflow_run` will eventually reach for. Both are 5-line wrappers around `run.cancel()`. |
| Fake API surface | Class with `enqueue(script)` | Functional callback-driven generator | Class lets a test set up the harness once and feed it scripts as scenarios run. Generator gives finer control but is rarely needed; `enqueue` is the 90% case. |
| Fake co-location | Same package, `test/fake.ts` | Separate `@ship/cursor-runner-fake` | Co-locating keeps the fake in step with the real (the type changes are caught by typecheck). One fewer package to publish-vs-not-publish decide. Matches the convention sketch in spec.md. |

## Engineering decisions

### ED-1 — `apiKey` is env-only, never in any persisted struct

Spec.md § Risks names this explicitly. Implementation: `LocalCursorRunner.run(input)` reads `process.env.CURSOR_API_KEY` at the moment of the SDK call. If unset, throws a typed `MissingApiKeyError` (exported from `errors.ts`). The key never touches `this`, `input`, the handle, or the NDJSON archive.

### ED-2 — Sole `@cursor/sdk` importer; enforced by test

A test (`tests/sdk-import-isolation.test.ts` at the repo root, or in `@ship/test-harness`) globs every `*.ts` file under `packages/*/src/**` except `packages/cursor-runner/src/**`, greps for `from "@cursor/sdk"`, and asserts zero matches. CI fails on any leak.

### ED-3 — Map `RunResult.status` to Ship's domain status, don't echo

The SDK uses `"finished" | "error" | "cancelled"`; Ship uses `"succeeded" | "failed" | "cancelled"`. The mapping happens here, not in `core`. Reasons:
- Keeps `core` agnostic of SDK vocabulary.
- The vocabulary change is the package's whole reason to exist.
- Makes future cloud / alternative-backend mappings the runner's call.

### ED-4 — `onEvent` is fire-and-forget; consumer owns errors

The runner doesn't `await onEvent(...)`. It calls it and moves on. Reasons:
- The stream is an async generator; back-pressure is managed by the SDK's generator semantics, not by waiting on the consumer.
- A consumer that needs to do async work per event (e.g. write-then-fsync) must queue internally.
- A throwing `onEvent` does NOT abort the run — it bubbles up to the consumer's async error handler. Documented in JSDoc.

### ED-5 — `FakeCursorRunner` lives in the same package

Same reasoning as `@ship/test-harness` co-locates fixtures: the fake is intimate with the real implementation. A type change in `CursorRunInput` should fail the fake's typecheck immediately, not after a separate package's CI runs. Per spec.md § Component responsibilities, "A `FakeCursorRunner` is exported under `cursor-runner/test/fake.ts`."

### ED-6 — No `Agent.list`, `Agent.resume`, `Agent.archive` in V1

The interface ships only `run`. Resume, list, and archive are V2 surfaces (per spec.md open question #6 — resume is V2). Adding them now would commit V1 to behaviors we haven't validated.

### ED-7 — `NdjsonEventWriter` is a class, not a callback

`core` constructs the writer once per workflow run, then passes `writer.write` as the runner's `onEvent`. Class state (the underlying stream) is hidden; the `.write` method is a stable bound method. This matches the pattern other runtime-touching packages use.

## API boundaries / contracts

The public surface re-exported from `packages/cursor-runner/src/index.ts`:

```ts
// === runner.ts ===
export type {
  CursorRunInput,
  CursorRunHandle,
  CursorRunResult,
  CursorRunner,
} from "./runner.js";
export { LocalCursorRunner } from "./local-runner.js";

// === ndjson.ts ===
export type { EventWriter } from "./ndjson.js";
export { createNdjsonEventWriter } from "./ndjson.js";

// === errors.ts ===
export {
  MissingApiKeyError,
  CursorRunFailedError,
} from "./errors.js";
```

Plus, under a separate entry point `cursor-runner/test/fake.ts`:

```ts
export type { FakeCursorScript } from "../src/fake.js";
export { FakeCursorRunner } from "../src/fake.js";
```

The fake is exported under a `test/` path so consumers' production code can never import it accidentally — matches the convention in spec.md § "Component responsibilities."

### Stability promise (within V1)

The `CursorRunner` interface is the contract `core` codes against. Adding fields to `CursorRunInput` / `CursorRunHandle` is fine if optional. Removing or renaming is a breaking change that updates `core` in the same commit.

### Error policy

Typed errors exported from `errors.ts`:

- `MissingApiKeyError` — `CURSOR_API_KEY` env var unset at `run()` time.
- `CursorRunFailedError` — wraps the SDK's terminal-error result; `.cause` carries the original. Used when the SDK reports `status: "error"`.

NDJSON writer errors propagate as standard `Error` via the stream's `error` event; not wrapped (the caller already knows it asked for fs writes).

## Validation plan

Tests live in `packages/cursor-runner/src/*.test.ts` (no scenarios package — the harness extension lives in `@ship/test-harness`).

### `LocalCursorRunner` (SDK mocked via `vi.mock("@cursor/sdk")`)

- ✅ Happy path: `run(input)` resolves a handle whose `result` resolves to `status: "succeeded"`, `summary` matches the mocked `RunResult.result`, `durationMs` matches.
- ✅ Status mapping: `RunResult.status: "finished"` → `"succeeded"`; `"error"` → `"failed"` with `errorMessage`; `"cancelled"` → `"cancelled"`.
- ✅ `onEvent` is called once per mocked `SDKMessage` in stream order.
- ✅ `onEvent` exception does NOT abort the SDK run (caught at the runner boundary, surfaced via the consumer's error path).
- ✅ Cancellation via `AbortSignal`: `signal.abort()` mid-stream → `run.cancel()` invoked once → handle resolves to `"cancelled"` within 5s.
- ✅ Cancellation via `handle.cancel()`: same.
- ✅ Cancel is idempotent (second call no-ops).
- ❌ `CURSOR_API_KEY` unset → `MissingApiKeyError` before any SDK call.
- ❌ SDK `Agent.create` throws → propagates as a wrapped error; agent NOT disposed (none was created).
- ✅ Successful run disposes the agent (`Symbol.asyncDispose` called once).

### `createNdjsonEventWriter`

- ✅ One JSON line per write; trailing newline.
- ✅ Multiple writes preserve order.
- ✅ `close()` flushes and closes the stream.
- ✅ `close()` is idempotent.
- ❌ Write to a non-existent directory → error surfaces via the stream's `error` event.

### `FakeCursorRunner`

- ✅ Scripted events emitted in order through `onEvent`.
- ✅ `result` resolves to the scripted `CursorRunResult`.
- ✅ `cancel()` with `cancelBehavior: "complete"` resolves the result to `"cancelled"`.
- ✅ `enqueue` FIFO behavior across multiple `run()` calls.
- ❌ `run()` with no script enqueued and no default → throws.

### Harness integration (lives in `@ship/test-harness`'s scenarios after this phase ships)

- ✅ Existing 5 scenarios continue to pass.
- ✅ New scenario: "agent succeeds; events archived to ndjson; result populated" wires the fake into the harness.

### Repo-wide isolation test

- ✅ ED-2's import-isolation grep finds zero `from "@cursor/sdk"` matches outside `packages/cursor-runner/src/**`.

### Acceptance

- `pnpm --filter @ship/cursor-runner test` exits 0.
- `pnpm typecheck` / `lint` / `format:check` from repo root pass.
- `make coverage` passes the 90/85 threshold.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SDK behavior diverges from Spike v1 (e.g. new event types, status name changes) | Runner ships against stale assumptions | Spike v2 (cancellation, `mcpServers` passthrough — Spike § Untested) runs in a throwaway script before this phase implements; findings amend `cursor-sdk-typescript.md`. |
| Cancellation timing is sloppy (run.cancel() takes >5s) | `cancelRun` MCP tool feels unresponsive | Validation plan asserts <5s; if the SDK can't meet it, surface as a known limitation in the runner's JSDoc and let `core` UI it. |
| `tool_call.args` schema breaks across SDK versions | NDJSON archive becomes unparseable | We persist the envelope and treat `args`/`result` as opaque per Spike § Confirmed. Documented in `docs/cursor-sdk-typescript.md`. |
| `RunResult.git` shape changes for cloud (V2) | V2 cloud impl breaks at the seam | Local impl uses `result.git?.branches ?? []`; cloud impl is a separate class so a shape change there doesn't ripple. |
| API key leaks into NDJSON | Credential leak in archive | ED-1 + a test that asserts `JSON.stringify(any-event)` never contains the key. Plus a CI grep on the archive itself in the e2e suite. |
| `@cursor/sdk` mock divergence from real behavior | Tests pass; production breaks | Spike v2 + the real SDK exercised in the e2e suite (Phase 9). The harness scenarios cover behavior the mock can simulate; live tests catch the rest. |
| NDJSON writer back-pressure on slow disk | Events buffered in memory unboundedly | V1 accepts. SDK event volume is low (~2/sec); a slow disk would manifest as elevated memory in seconds, not hours. Documented; revisit if Spike v2 shows differently. |

## Open questions

1. **Spike v2 scope.** Proposed: a half-day spike before 5b that exercises (a) cancellation timing, (b) `mcpServers` passthrough, (c) `RunResult.git` for a cloud run if convenient. Output: amend `cursor-sdk-typescript.md` § Spike findings with a "run 2" subsection.
2. **`onEvent` async signature.** Currently typed as `(event: SDKMessage) => void`. Should we accept `=> void | Promise<void>` and `await` it? Proposed: no for V1 (per ED-4); revisit if `core` wants per-event async work and `setImmediate(onEvent)` isn't enough.
3. **Default model in the runner.** Should `LocalCursorRunner` accept a `defaultModel` constructor arg, or always require `model` per call? Proposed: per call; `core` resolves the default from config.
4. **Where does the import-isolation test live?** Proposed: `@ship/test-harness/scenarios/sdk-import-isolation.scenario.test.ts` since it's a cross-package invariant. Alternative: a standalone test under `tests/repo-invariants/` at the repo root. Lean: harness, since it's already where cross-package facts live.

## Implementation plan

After review/approval, implement in this order. Each numbered step is a PR boundary unless the **5a/5b sub-PR plan** below changes it.

### 5a — scaffold + types + NDJSON writer + FakeCursorRunner

1. **`packages/cursor-runner/{package.json, tsconfig.json, vitest.config.ts}`** — workspace wiring per Phase 4's pattern. Deps: `@ship/workflow` (`workspace:*`); devDeps: `@types/node`. **No `@cursor/sdk` dep yet** — lands in 5b.
2. **`src/runner.ts`** — `CursorRunner` / `CursorRunInput` / `CursorRunHandle` / `CursorRunResult` types. Pure types; no implementation.
3. **`src/errors.ts`** — `MissingApiKeyError`, `CursorRunFailedError`.
4. **`src/ndjson.ts` + tests** — `createNdjsonEventWriter`, `EventWriter` interface, behavior tests (one line per write, ordering, close idempotency, error surface).
5. **`src/fake.ts` + tests** — `FakeCursorRunner`, `FakeCursorScript`, behavior tests (scripted emission, FIFO, cancel behavior, run-without-script throws).
6. **`src/index.ts`** + **`test/fake.ts`** — barrels.
7. **`packages/test-harness`** — extend `Harness` with optional `cursor: FakeCursorRunner` (additive; existing scenarios keep working). Scenario added that exercises the fake end-to-end.
8. **Repo-wide isolation test** added per ED-2.
9. **`make check`** + **`make coverage`** — green from repo root.

### 5b — `LocalCursorRunner` (the `@cursor/sdk` impl)

10. **Spike v2** (throwaway, NOT committed beyond a `cursor-sdk-typescript.md` addendum) — exercises cancellation + `mcpServers` passthrough.
11. **`packages/cursor-runner` deps** — add `@cursor/sdk` to `dependencies`. Update root `pnpm.onlyBuiltDependencies` allowlist if Spike v2 reveals a new native dep (per Spike v1's `sqlite3` finding).
12. **`src/local-runner.ts` + tests** — `LocalCursorRunner` class. SDK mocked via `vi.mock("@cursor/sdk")`. Tests cover the validation plan's "LocalCursorRunner" section (status mapping, onEvent ordering, cancellation, env-var enforcement, agent disposal).
13. **`src/index.ts`** — export `LocalCursorRunner`.
14. **`make check`** + **`make coverage`** — green.
15. **Mark Phase 5 done in [plan.md](../plan.md).**

Total LOC estimate (per CLAUDE.md weighting): ~540 src + ~380 tests = **730 weighted**. Sub-PR plan keeps each PR under 500 amazing.

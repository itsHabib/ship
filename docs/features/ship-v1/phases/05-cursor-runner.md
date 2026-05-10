# Phase 5 — `packages/cursor-runner`

Status: design draft, revision 1 (2026-05-09). Review pass applied; ready for implementation.
Owner: itsHabib
Date: 2026-05-09

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec; § "Component responsibilities" and § "Internal interfaces" pin the runner's contract. [docs/cursor-sdk-typescript.md](../../../cursor-sdk-typescript.md) is the SDK reference, with the **load-bearing § "Spike findings"** at the bottom — every "what does the SDK actually do" claim in this doc cites that section, not the reference. [phases/04-qe-sdet.md](04-qe-sdet.md) shipped the `@ship/test-harness` consumer that this package's `FakeCursorRunner` plugs into. The PR sizing rule in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:** ~480 src + ~290 tests = **625 weighted LOC** (under the < 700 ideal band).

The honest split — preferred: **land as 2 PRs**, both well under 500 amazing:

| Sub-PR | Source | Tests | Weighted |
|---|---|---|---|
| **5a** scaffold + types + `FakeCursorRunner` + ED-2 isolation test (`@cursor/sdk` in deps for type-only imports) | ~220 | ~110 | ~275 |
| **5b** `LocalCursorRunner` (the only runtime user of `@cursor/sdk`) | ~260 | ~180 | ~350 |

5a is the safe surface — pure types, the scriptable fake, and the import-isolation invariant. The `@cursor/sdk` package is in `dependencies` from 5a (used for `import type` only), but no code in 5a *invokes* the SDK. 5b adds the only runtime SDK call site (`LocalCursorRunner`) so reviewers can focus on SDK shape correctness without the noise of the rest of the package.

The implementation plan steps within each sub-PR are an *ordering*, not separate PR boundaries — `package.json`/barrel/CI-check steps are subordinate to the feature unit they wire up. The 5a / 5b split is the actual PR boundary. Both sub-PRs are well under the < 500 amazing band, so a single-PR fallback (~625 weighted) is also acceptable if reviewers prefer one full picture; the SDK-shape isolation argument for splitting still stands.

NDJSON event writing previously lived in this package; it's been moved to `core` (Phase 6) since it's a generic "JSON-lines append-only writer" that doesn't depend on `@cursor/sdk` and `core` is its only call site. See § Tradeoffs.

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
7. Disposes the agent (`agent[Symbol.asyncDispose]()`) in a `finally` block — **regardless of stream success, throw, or cancel**. If `Agent.create` throws, no agent exists and no disposal happens. If `agent.send` throws after a successful `Agent.create`, the agent is still disposed in the catch path before the runner re-throws.

The implementation does NOT:
- Block waiting for a `system` event to fire (Spike § Surprises observed none in the happy-path run; the de-facto start signal is the first `status: "RUNNING"`).
- Synthesize events the SDK didn't emit.
- Parse `tool_call.args` / `tool_call.result` (Spike § Confirmed: those are unstable). The envelope (`type`, `call_id`, `name`, `status`) is stable; the payloads pass through to `onEvent` as opaque.

### F3 — Cancellation

Cancel is reachable from two paths, both idempotent:

- **`signal: AbortSignal`** — caller passes one; the runner attaches `signal.onabort` to call `run.cancel()`. Used by `core` to wire SIGINT or per-run timeout.
- **`handle.cancel()`** — the runner exposes a method on the returned handle. Useful in tests and for future cancel-by-id paths from the MCP server.

Idempotence is enforced runner-side: the handle tracks a `terminated` flag set when `run.wait()` resolves *or* when `cancel()` is called. A second `cancel()` (either path) returns immediately without invoking `run.cancel()` again — we do not rely on SDK-side idempotence since spike #1 left cancel-after-terminal untested.

Per spike § Untested: cancellation was NOT exercised in spike #1. Phase 5 is where we exercise it (Spike v2 prefaces 5b). Validation plan asserts the run terminates within **30s** of cancel; if Spike v2 shows the SDK regularly hits <5s we tighten the assertion. Partial output is preserved per the SDK doc.

### F4 — `FakeCursorRunner` for downstream tests

Source lives at `packages/cursor-runner/src/fake.ts`; consumers reach it via the subpath import `@ship/cursor-runner/test/fake` (wired by `package.json#exports`, see § "API boundaries / contracts"). The `test/` namespace makes it grep-obvious at the import site that this is a test-only helper, even though the source is colocated in `src/`. Shape:

```ts
export interface FakeCursorScript {
  events: SDKMessage[];                              // emitted in order; sync by default
  result: CursorRunResult;                           // resolved by handle.result
  cancelBehavior?: "complete" | "ignore" | "throw"; // how cancel() interacts with the script
  delayMsBetweenEvents?: number;                     // default 0 → events fire synchronously,
                                                     // matching the real runner's per-event call shape
}

export class FakeCursorRunner implements CursorRunner {
  constructor(opts?: { defaultScript?: FakeCursorScript });
  enqueue(script: FakeCursorScript): void;           // queue per-call scripts
  run(input: CursorRunInput): Promise<CursorRunHandle>;
}
```

A scenario test calls `enqueue(...)` once per expected `run()` call; the fake pops scripts in FIFO order. If `run()` is called more times than scripts were enqueued and no `defaultScript` was provided, the fake throws — caught by tests so misconfigured scenarios fail loud.

By default events emit synchronously (same microtask) so the fake's call shape mirrors the real runner's per-iteration `for await` invocation of `onEvent`. Tests asserting "events arrived before result resolved" depend on this; opt into async pacing only when the test deliberately wants delays.

`@ship/test-harness` integration is **deferred to Phase 6**. The harness gains a `cursor: FakeCursorRunner` field once `core` exists and a scenario can drive a workflow lifecycle through it end-to-end. Adding the field in Phase 5 with no `core` to populate it would mean the only "scenario" was duplicating the fake's own unit tests.

## Non-functional requirements

- **Sole `@cursor/sdk` importer (any kind).** A repo-wide grep test (`packages/*/src/**/*.ts` minus `packages/cursor-runner/{src,test}/**`) MUST find zero `from "@cursor/sdk"` matches — type-only included. Other packages reach SDK types via `@ship/cursor-runner`'s re-exports (`CursorRunInput`, etc.), never directly. Locks the seam at one filename.
- **Zero side effects on import.** No SDK calls, no `Agent.create`, no fs writes at module load.
- **No API key in any persisted struct.** `LocalCursorRunner` reads `process.env.CURSOR_API_KEY` at `run()` time and immediately passes it to `Agent.create`. The key never lives on `this`, on the `CursorRunInput`, in any logged event, or in any artifact this package produces.
- **`onEvent` exceptions never abort the run.** The runner wraps each `onEvent(ev)` call in `try/catch` and silently swallows; consumers that need visibility queue async work and use their own error handling. See ED-4.
- **Strict TS + lint matching the rest of the repo.** `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`. Same eslint cap on params / lines / depth.
- **Coverage threshold:** 90% statements / 85% branches per the existing band for runtime-touching code (matches `@ship/store`). Set in this package's `vitest.config.ts`.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Substrate API shape | One `CursorRunner` interface; one impl per runtime | `runtime: "local" \| "cloud"` field on `CursorRunInput` | Polymorphism beats a discriminator string. The cloud impl will need different state (env vars, repos, PR autocreate) than local; folding both behind one type would force union-typed input. |
| API key plumbing | Env-only, read at `run()` time | Accept on `CursorRunInput` | Spec.md § Risks: "The `cursor-runner` package never accepts a key in any persisted struct." Env-only enforces this at the type level. |
| Event surfaces | Pass `SDKMessage` to `onEvent` verbatim | Normalize into a Ship-internal event union | Spike confirmed envelope shape is stable; payloads (`tool_call.args`/`result`) are opaque anyway. Normalization adds churn without adding stability. |
| Stream consumption | `for await ... of run.stream()` | `onDelta` callback | `stream()` is the documented event surface; `onDelta` is finer-grained and gives token deltas. V1 doesn't need token-level resolution. |
| NDJSON writer location | Lives in `core` (Phase 6) | Lives in `cursor-runner` | The writer is a generic JSON-lines append helper; it doesn't import `@cursor/sdk` and `core` is its only call site. Keeping it here would split "things related to file-system artifacts" across two packages. Tradeoff: `cursor-runner`'s SDK-archive contract is implicit (the runner emits `SDKMessage`; the writer just writes them). Acceptable. |
| `onEvent` error handling | Catch and swallow | Surface via separate `onEventError` callback / reject `result` | Simpler contract: `onEvent` is fire-and-forget, sync, no-throw. If a consumer must do async work, it queues internally. A throwing `onEvent` is a contract violation; the runner doesn't add a parallel error channel for it. See ED-4. |
| Cancellation surface | Both `AbortSignal` and `handle.cancel()` | One or the other | Signal is composable with timers; `handle.cancel()` is what the MCP `cancel_workflow_run` will eventually reach for. Both are 5-line wrappers around `run.cancel()`, plus the runner-side terminal-state guard from F3. |
| Fake API surface | Class with `enqueue(script)` | Functional callback-driven generator | Class lets a test set up the harness once and feed it scripts as scenarios run. Generator gives finer control but is rarely needed; `enqueue` is the 90% case. |
| Fake co-location | Same package, `test/fake.ts` | Separate `@ship/cursor-runner-fake` | Co-locating keeps the fake in step with the real (the type changes are caught by typecheck). One fewer package to publish-vs-not-publish decide. Matches the convention sketch in spec.md. |

## Engineering decisions

### ED-1 — `apiKey` is env-only, never in any persisted struct

Spec.md § Risks names this explicitly. Implementation: `LocalCursorRunner.run(input)` reads `process.env.CURSOR_API_KEY` at the moment of the SDK call. If unset, throws a typed `MissingApiKeyError` (exported from `errors.ts`). The key never touches `this`, `input`, the handle, the streamed events passed to `onEvent`, or any artifact downstream packages produce from this runner's output.

### ED-2 — Sole `@cursor/sdk` importer (any kind); enforced by test

The package's `package.json` lists `@cursor/sdk` in `dependencies` from 5a. 5a uses it for `import type { SDKMessage, McpServerConfig } from "@cursor/sdk"` only; 5b adds the runtime `import { Agent } from "@cursor/sdk"` in `LocalCursorRunner`.

A test at `packages/cursor-runner/test/sdk-import-isolation.test.ts` globs every `*.ts` file under `packages/*/{src,test}/**` except `packages/cursor-runner/{src,test}/**`, greps for `from "@cursor/sdk"` (matches both `import` and `import type`), and asserts zero matches. CI fails on any leak.

The test lives in the host package whose invariant it enforces — not in `@ship/test-harness/scenarios/` (it's a static repo invariant, not a lifecycle scenario) and not at a top-level `tests/` dir (none exists in the repo today).

Other packages reach SDK types via `@ship/cursor-runner`'s re-exports (`CursorRunInput`, `CursorRunResult`, etc.). They never name `@cursor/sdk` directly.

### ED-3 — Map `RunResult.status` to Ship's domain status, don't echo

The SDK uses `"finished" | "error" | "cancelled"`; Ship uses `"succeeded" | "failed" | "cancelled"`. The mapping happens here, not in `core`. Reasons:
- Keeps `core` agnostic of SDK vocabulary.
- The vocabulary change is the package's whole reason to exist.
- Makes future cloud / alternative-backend mappings the runner's call.

### ED-4 — `onEvent` is fire-and-forget; runner catches and swallows on throw

The runner doesn't `await onEvent(...)`. It calls it inside a `try { onEvent(ev); } catch { /* swallow */ }` block and moves on. Reasons:
- The stream is an async generator; back-pressure is managed by the SDK's generator semantics, not by waiting on the consumer.
- A consumer that needs to do async work per event (e.g. write-then-fsync) must queue internally.
- A throwing `onEvent` is a **contract violation**, not a recoverable condition. We don't add a parallel error channel (`onEventError`, `result.eventErrors`, etc.) for it — that's complexity for a case the consumer should fix at the source. The throw is silently dropped; the SDK run is unaffected.

This contract is documented in the JSDoc on `CursorRunInput.onEvent`. The validation plan asserts the swallow behavior (test: `onEvent` that throws synchronously does NOT abort the run; the run resolves to `succeeded`).

### ED-5 — `FakeCursorRunner` lives in the same package

Same reasoning as `@ship/test-harness` co-locates fixtures: the fake is intimate with the real implementation. A type change in `CursorRunInput` should fail the fake's typecheck immediately, not after a separate package's CI runs. Per spec.md § Component responsibilities, "A `FakeCursorRunner` is exported under `cursor-runner/test/fake.ts`."

### ED-6 — No `Agent.list`, `Agent.resume`, `Agent.archive` in V1

The interface ships only `run`. Resume, list, and archive are V2 surfaces (per spec.md open question #6 — resume is V2). Adding them now would commit V1 to behaviors we haven't validated.

### ED-7 — Harness extension lives in Phase 6, not here

`@ship/test-harness` does not gain a `cursor: FakeCursorRunner` field in Phase 5. The fake exists (5a) and is unit-tested in this package (`src/fake.test.ts`). Wiring it into the harness is meaningful only when `core` exists in Phase 6 and a scenario can drive a workflow lifecycle through it; doing so in Phase 5 would mean the only "scenario" was duplicating fake unit tests. Phase 6's task doc owns that extension.

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

// === errors.ts ===
export {
  MissingApiKeyError,
  CursorRunFailedError,
} from "./errors.js";
```

Plus, under a separate `./test/fake` subpath that consumers' production code can never accidentally import — matches the convention in spec.md § "Component responsibilities":

```ts
// packages/cursor-runner/src/fake.ts (the actual source)
export type { FakeCursorScript } from "./fake.js";
export { FakeCursorRunner } from "./fake.js";
```

`package.json#exports` wires the subpath. Per repo convention (no build step; consumers read TS source directly), entries point at `./src/...`, matching the existing `@ship/store` / `@ship/workflow` / `@ship/test-harness` packages:

```json
{
  "exports": {
    ".":           { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./test/fake": { "types": "./src/fake.ts",  "default": "./src/fake.ts" }
  }
}
```

Consumer code: `import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";`

There's no precedent for subpath exports in this repo (`@ship/test-harness` uses a single barrel). Step 1 of 5a's implementation plan adds this map alongside the other `package.json` wiring.

### Stability promise (within V1)

The `CursorRunner` interface is the contract `core` codes against. Adding fields to `CursorRunInput` / `CursorRunHandle` is fine if optional. Removing or renaming is a breaking change that updates `core` in the same commit.

### Error policy

Two distinct paths — *throw* vs *resolve-with-failure*:

**Runner throws (rejects the `run(input)` promise or the `handle.result` promise) when:**
- `MissingApiKeyError` — `CURSOR_API_KEY` env var unset at `run()` time. Thrown before any SDK call.
- `CursorRunFailedError` — `Agent.create` or `agent.send` itself throws (no agent / no run was ever created on the SDK side). `.cause` carries the original SDK error. Disposal in a `finally` handles partial state.

**Runner resolves `handle.result` with `{ status: "failed", errorMessage }` when:**
- The SDK reports `RunResult.status === "error"`. The run *did* exist; it just terminated unsuccessfully. The runner does NOT throw here — failure is part of the normal terminal-state vocabulary, surfaced through the result type the same way `succeeded` is.

This split keeps "the SDK gave us a result, including a failure result" distinct from "we couldn't even start the run." Consumers (`core`) handle the two cases differently: a thrown `CursorRunFailedError` may warrant a retry; a resolved `failed` result is the agent's own verdict and goes straight to the workflow row.

## Validation plan

Tests live in `packages/cursor-runner/src/*.test.ts` plus the import-isolation invariant at `packages/cursor-runner/test/sdk-import-isolation.test.ts`. No scenarios in this phase — harness scenarios that drive a workflow lifecycle through the fake land in Phase 6 with `core` (per ED-7).

### `LocalCursorRunner` (SDK mocked via `vi.mock("@cursor/sdk")`)

- ✅ Happy path: `run(input)` resolves a handle whose `result` resolves to `status: "succeeded"`, `summary` matches the mocked `RunResult.result`, `durationMs` matches.
- ✅ Status mapping: `RunResult.status: "finished"` → resolves to `"succeeded"`; `"error"` → resolves to `"failed"` with `errorMessage`; `"cancelled"` → resolves to `"cancelled"`. **Note:** `"error"` is a *resolve*, not a throw — only pre-run SDK throws (`Agent.create` / `agent.send`) reject; see § Error policy.
- ✅ `onEvent` is called once per mocked `SDKMessage` in stream order.
- ✅ `onEvent` that throws synchronously is swallowed; the SDK run resolves to `"succeeded"` (or its actual terminal status) and the result is populated.
- ✅ Cancellation via `AbortSignal`: `signal.abort()` mid-stream → `run.cancel()` invoked once → handle resolves to `"cancelled"` within 30s. (If Spike v2 shows the SDK regularly hits <5s, tighten to 5s before merging 5b.)
- ✅ Cancellation via `handle.cancel()`: same.
- ✅ Cancel is idempotent: second call no-ops without reaching the SDK; verified by asserting `run.cancel` mock is called exactly once across two `cancel()` invocations.
- ✅ Cancel after natural terminal status: no-op (no second `run.cancel` call).
- ❌ `CURSOR_API_KEY` unset → `MissingApiKeyError` before any SDK call.
- ❌ SDK `Agent.create` throws → wrapped in `CursorRunFailedError`; agent NOT disposed (none was created).
- ❌ SDK `agent.send` throws after a successful `Agent.create` → wrapped in `CursorRunFailedError`; agent IS disposed in the finally block (assert via the mock's dispose spy).
- ✅ Successful run disposes the agent (`Symbol.asyncDispose` called once).

### `FakeCursorRunner`

- ✅ Scripted events emitted in order through `onEvent` synchronously by default.
- ✅ With `delayMsBetweenEvents > 0`, events are paced via timers; ordering preserved.
- ✅ `result` resolves to the scripted `CursorRunResult`.
- ✅ `cancel()` with `cancelBehavior: "complete"` resolves the result to `"cancelled"`.
- ✅ `cancel()` with `cancelBehavior: "ignore"` runs the script to completion regardless.
- ✅ `enqueue` FIFO behavior across multiple `run()` calls.
- ❌ `run()` with no script enqueued and no default → throws.

### Repo-wide isolation test

- ✅ ED-2's import-isolation grep finds zero `from "@cursor/sdk"` matches under `packages/*/{src,test}/**` outside `packages/cursor-runner/{src,test}/**`. Lives at `packages/cursor-runner/test/sdk-import-isolation.test.ts`.

### Acceptance

- `pnpm --filter @ship/cursor-runner test` exits 0.
- `pnpm typecheck` / `lint` / `format:check` from repo root pass.
- `make coverage` passes the 90/85 threshold.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SDK behavior diverges from Spike v1 (e.g. new event types, status name changes) | Runner ships against stale assumptions | Spike v2 (cancellation timing + minimal `mcpServers` passthrough — Spike § Untested) runs in a throwaway script before 5b implements; findings amend `cursor-sdk-typescript.md`. |
| Cancellation timing is sloppy (run.cancel() takes >5s) | `cancelRun` MCP tool feels unresponsive | Validation plan asserts <30s; Spike v2 measures actual numbers and either tightens the assertion (if SDK comfortably hits <5s) or accepts the looser bound and surfaces it in the runner's JSDoc for `core` to UI. |
| `tool_call.args` schema breaks across SDK versions | Persisted event archive becomes unparseable | Runner emits `SDKMessage` to `onEvent`; the archive treats `args`/`result` as opaque per Spike § Confirmed. Documented in `docs/cursor-sdk-typescript.md`. |
| `RunResult.git` shape changes for cloud (V2) | V2 cloud impl breaks at the seam | Local impl uses `result.git?.branches ?? []`; cloud impl is a separate class so a shape change there doesn't ripple. |
| API key leaks into stream events / `result` | Credential leak in archive | ED-1 + a test that asserts `JSON.stringify(handle.result)` and `JSON.stringify(any-streamed-event)` never contain the key. Plus a CI grep on the artifact archive itself in the e2e suite. |
| `@cursor/sdk` mock divergence from real behavior | Tests pass; production breaks | Spike v2 + the real SDK exercised in the e2e suite (Phase 9). Unit tests cover behavior the mock can simulate; live tests catch the rest. |

## Open questions

1. **Spike v2 scope.** A half-day spike before 5b that exercises:
   - (a) **Cancellation timing** — primary. Measure how long `run.cancel()` takes to drive the run to terminal status across a few prompt sizes. Output: a number that informs the validation plan's <30s assertion (tighten to <5s if the SDK comfortably hits it).
   - (b) **`mcpServers` passthrough** — minimum bar. Pass an `McpServerConfig` to `Agent.create`, verify the SDK accepts it without throwing and the run completes. We do NOT need to verify the agent actually invokes the MCP server (that's a Phase 9 e2e concern).
   - Removed from spike scope: cloud-runtime `RunResult.git` validation. Cloud is V2; local-only for V1.

   Output: amend `cursor-sdk-typescript.md` § Spike findings with a "run 2" subsection.
2. **`onEvent` async signature.** Currently typed as `(event: SDKMessage) => void`. Should we accept `=> void | Promise<void>` and `await` it? Proposed: no for V1 (per ED-4); revisit if `core` wants per-event async work and `setImmediate(onEvent)` isn't enough.
3. **Default model in the runner.** Should `LocalCursorRunner` accept a `defaultModel` constructor arg, or always require `model` per call? Proposed: per call; `core` resolves the default from config.
4. ~~**Where does the import-isolation test live?**~~ **Resolved (in this revision):** lives at `packages/cursor-runner/test/sdk-import-isolation.test.ts` — a static repo invariant belongs to the package whose seam it enforces, not in `@ship/test-harness/scenarios/` (which is for lifecycle scenarios) or a standalone top-level dir (none exists today).

## Implementation plan

After review/approval, implement as **two PRs** (5a and 5b). Within each sub-PR, the numbered steps are an *ordering* — package wiring, barrels, and CI-green checks are subordinate to the feature unit they support, not separate PR boundaries. The 5a / 5b split is the actual boundary.

### 5a — scaffold + types + `FakeCursorRunner` + isolation test

1. **`packages/cursor-runner/{package.json, tsconfig.json, vitest.config.ts}`** — workspace wiring per Phase 4's pattern. Deps: `@ship/workflow` (`workspace:*`), `@cursor/sdk` (used for `import type` only in 5a — runtime usage lands in 5b). DevDeps: `@types/node`. `package.json#exports` includes both `"."` and `"./test/fake"` per § "API boundaries / contracts." `vitest.config.ts` sets the 90/85 coverage threshold.
2. **`src/runner.ts`** — `CursorRunner` / `CursorRunInput` / `CursorRunHandle` / `CursorRunResult` types. Pure types; type-only imports of `SDKMessage` / `McpServerConfig` from `@cursor/sdk`.
3. **`src/errors.ts`** — `MissingApiKeyError`, `CursorRunFailedError`.
4. **`src/fake.ts` + tests** — `FakeCursorRunner`, `FakeCursorScript`. Tests cover the validation plan's "FakeCursorRunner" section (synchronous emission default, async pacing opt-in, FIFO, cancel behaviors, run-without-script throws).
5. **`src/index.ts`** — barrel for the main entry. Subpath-fake export resolves to `./src/fake.ts` via `package.json#exports` (consistent with the no-build-step convention used by every other `@ship/*` package).
6. **`test/sdk-import-isolation.test.ts`** — implements ED-2: globs `packages/*/{src,test}/**` minus this package, asserts zero `from "@cursor/sdk"` matches.
7. **`make check`** + **`make coverage`** — green from repo root.

### 5b — `LocalCursorRunner` (the only runtime user of `@cursor/sdk`)

1. **Spike v2** (throwaway, NOT committed beyond a `cursor-sdk-typescript.md` addendum) — cancellation timing + minimal `mcpServers` passthrough per Open Q1.
2. **`pnpm.onlyBuiltDependencies` allowlist** — update root `package.json` if Spike v2 reveals a new native transitive dep (per Spike v1's `sqlite3` finding).
3. **`src/local-runner.ts` + tests** — `LocalCursorRunner` class with runtime `import { Agent } from "@cursor/sdk"`. SDK mocked via `vi.mock("@cursor/sdk")`. Tests cover the validation plan's "LocalCursorRunner" section (status mapping incl. throw-vs-resolve split, onEvent ordering, swallowed-throw, cancellation timing within 30s, env-var enforcement, agent disposal in `finally` for create-throws / send-throws / success).
4. **`src/index.ts`** — add `LocalCursorRunner` export.
5. **`make check`** + **`make coverage`** — green.
6. **Mark Phase 5 done in [plan.md](../plan.md).**

Total LOC estimate (per CLAUDE.md weighting): ~480 src + ~290 tests = **625 weighted** — under the < 700 ideal band. 5a is ~275 weighted; 5b is ~350 weighted; both are well under 500 amazing.

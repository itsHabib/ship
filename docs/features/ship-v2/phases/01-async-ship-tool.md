# Phase 01 — Async `ship` MCP tool

Status: design draft, revision 1 (2026-05-10). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-10

> **Companion docs.** [spec.md](../spec.md) anchors V2. [ship-v1/spec.md § F1](../../ship-v1/spec.md) defined the current sync `ship` contract this phase changes. [ship-v1/phases/08-mcp-server.md](../../ship-v1/phases/08-mcp-server.md) is the V1 MCP server this phase reaches into. [ship-v1/phases/09-bug-smash.md § Outcome](../../ship-v1/phases/09-bug-smash.md) records the dogfood measurements that motivated the change. The PR sizing rule in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:** docs-only for this PR. **0× weighted.** "Amazing" band (< 500) trivially.

The follow-up implementation PR has its own budget; preliminary estimate is ~120 src + ~180 tests = ~210 weighted LOC, comfortably inside "amazing." That estimate is not binding on this doc-only PR — it's documented here so the impl PR's scope is visible at design-review time.

## Summary

V1 ships a single MCP `ship` tool that blocks until the workflow run is terminal. Real ship-on-ship dogfood runs measured during V1 phase 9 take **90–200 seconds** (PR [#21](https://github.com/itsHabib/ship/pull/21) was 126s end-to-end). The MCP request timeout for any tool call is approximately **60 seconds**. Result: every agent-initiated `ship.ship` call times out at the transport layer even though the workflow continues durably in the background, and the caller has to fall back to polling `ship.get_workflow_run`.

This phase changes the `ship` MCP tool to return `{ workflowRunId, status }` immediately after the run row + initial phase row are persisted. The Cursor agent run continues in the background; `get_workflow_run` is the (already-shipped) poll surface for terminal state. The CLI path is unaffected — `ShipService.ship` stays synchronous; only the MCP boundary's tool handler changes.

This is the single smallest unblock for every later V2 phase that needs to call `ship` from an agent.

## Functional requirements

### F1 — `ship` MCP tool returns immediately after persistence

After this phase:

1. The MCP `ship` tool validates input via `shipInputSchema` (unchanged).
2. The tool handler calls a new `ShipService.startShip(input)` method (see ED-1). The synchronous step ordering inside `startShip` is exact. Step 2.a is the one `await`; after it resolves, steps 2.b through 2.e run on the same resumed synchronous call stack with no `await` between them:
   - **2.a** Pre-row validation: `await validateWorkdirAndDoc(...)`. The only suspension point in `startShip`. Throws ⇒ no row, `startShip` rejects.
   - **2.b** Persist: `persistInitialState(...)` writes the `WorkflowRun` row + initial implement-`Phase` row with V1's default status `pending`. Throws ⇒ same as above plus DB rolls back per V1.
   - **2.c** Transition: `markRunStarted(...)` — one synchronous SQLite write taking row + phase from `pending → running`. Throws ⇒ row stays `pending`, no `activeRuns` entry exists yet so nothing to clean up.
   - **2.d** Register controller: `activeRuns.set(workflowRunId, { controller, ... })`. After this point, an incoming `cancelRun(workflowRunId)` can observe the run. Registration happens **after** the transition (per ED-2's revised ordering) so a failed transition doesn't leak a stale active-runs entry; no concurrency window is opened, because steps 2.c → 2.d → 2.e are on the same synchronous call stack.
   - **2.e** Schedule continuation: `setImmediate(() => executeAndFinalize(...).catch(safetyNet))`. Returns control to the caller after the next tick of the event loop is queued.
   - **2.f** Return `ShipStartOutput` of shape `{ workflowRunId, status: "running" }`. The `running` value is by design — see ED-3 for the schema-level pinning.
3. The tool handler validates output against a new `shipStartOutputSchema` and returns it.
4. The MCP tool **never** blocks waiting on the Cursor agent.

### F2 — `ShipService.ship` (sync) remains for the CLI

The CLI's `ship ship` subcommand keeps the V1 sync behavior — it blocks, prints status to stdout, and exits with a code reflecting the terminal status. Humans want sync at the CLI; agents need async at the MCP.

`ShipService.ship(input): Promise<ShipOutput>` is preserved unchanged. The new `ShipService.startShip(input): Promise<ShipStartOutput>` is added alongside it. CLI uses the former; MCP server uses the latter. See ED-1 for the rationale on splitting at the service layer rather than at the MCP handler.

### F3 — Cancellation semantics unchanged

`cancel_workflow_run` continues to work the V1 way. `activeRuns` is populated by `startShip` exactly as it is by V1's `ship` (the controller is registered synchronously inside `startShip` so the background continuation observes the abort signal via the existing V1 signal-observation path).

A specific guard required for safety: the `activeRuns.set(...)` call must complete **before the `setImmediate` callback runs** (per F1 step 2.d and the ED-2 sketch). Since both registration and the `setImmediate(...)` call are on the same synchronous call stack with no `await` between them, this is true by construction — the callback can't fire until the current call stack unwinds, which is after `return` from `startShip`. A cancel arriving between "tool returns" and "background continuation begins" finds the entry in `activeRuns` and aborts cleanly.

### F4 — `get_workflow_run` is the poll surface

No change to `get_workflow_run`. Callers poll it by `workflowRunId` until `isTerminal(status)`. The V1 `WorkflowRun` shape (status + phases + artifacts) already exposes everything the caller needs; the artifacts paths are populated by the background continuation as it writes them, same as today.

## Non-functional requirements

- **Backwards-compatible at the data layer.** No SQL schema changes. Existing `WorkflowRun` rows hydrate unchanged.
- **Forwards-incompatible at the MCP tool layer.** The `ship` tool's response shape changes. Documented in the implementation PR's changelog + the V1→V2 migration note in [spec.md](../spec.md) ED-3. There is no V1 client today that depends on the sync-response shape *and* uses it successfully — the 60s timeout has been preventing that since V1 shipped — so this is a small real-world break.
- **No new dependency.** Implementation reuses the existing `setImmediate` / queueMicrotask primitives Node already exposes; no `p-queue` / `bree` / event-emitter library.
- **Tests at every layer.** New unit tests for `startShip` against fakes; MCP handler smoke test that asserts the new return shape and that the background continuation completes; one new L3 subprocess integration test under `e2e/integration/` that fires `ship`, asserts the immediate return, polls `get_workflow_run`, and asserts terminal status.
- **Strict TS + lint matching the rest of the repo.** Same coverage thresholds as `mcp-server` from V1 phase 8 (80% statements / 75% branches).
- **Calibrated comment style** per the repo standard. JSDoc on every exported member.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Where to split sync / async | Service layer: `ship` (sync) + `startShip` (async) | At the MCP handler — handler fires-and-forgets `ship` itself | Splitting at the service keeps the sync code path identical to V1 for the CLI and gives the MCP a clean named method to call. Fire-and-forgetting `ship` from the handler would leak the un-awaited promise inside the MCP server, complicate cancellation registration, and tangle the existing error mapping. |
| Tool naming | Keep `ship` as the tool name; change its return contract | Add a new `start_ship` tool; deprecate `ship` | The current sync return shape isn't usable from an agent today (60s timeout), so almost no real caller depends on it. Keeping the name + changing the contract avoids tool-surface bloat and a deprecation cycle for a contract that nobody successfully consumes. |
| Return shape on async path | `{ workflowRunId, status }` only | Return the full `WorkflowRun` row at start | At start time, the row has no artifacts, no cursor run, no terminal status — most of the rich fields are empty. Returning the minimal shape and asking callers to poll `get_workflow_run` keeps the contract honest and the response small. |
| Background-continuation primitive | `setImmediate` (yields to I/O before running) | `queueMicrotask` (same-tick) / a worker thread / pool | `setImmediate` has explicit "after this turn of the event loop" semantics, which keeps the test surface for cancellation deterministic. Worker threads are out of proportion to the change — existing run model is single-process, single-user per spec.md § Non-functional. |
| Streaming progress responses | Deferred to a later phase | Implement SSE in the same PR | MCP SDK's progress notifications are not yet uniformly supported across editors / agent runtimes we care about. Async-return + poll works with every client. |
| CLI changes | None | Add `ship ship --async` flag | The CLI's blocking behavior is correct for humans. No demand signal for an async CLI. Adding a flag is feature creep. |

## Engineering decisions

### ED-1 — Split sync vs async at the `ShipService` layer

`packages/core/src/service.ts` gains `startShip(input): Promise<ShipStartOutput>` alongside the existing `ship(input): Promise<ShipOutput>`. The shared body is the V1 `shipImpl` factored into three parts (the middle helper is new in V2; the outer two already exist in V1 in some form):

```
shipImpl(ctx)
  = await prepareRun(ctx)         // validation + persistInitialState (both → status `pending`)
  → markRunStarted(ctx, prep)     // sync SQLite write: row + phase `pending → running` (new helper)
  → executeAndFinalize(ctx, prep) // existing V1 path, with the pending→running step factored out
```

`startShip` follows the exact ordering enumerated in F1 step 2: `prepareRun` (validate + persist) → `markRunStarted` → `activeRuns.set` → `setImmediate(executeAndFinalize)` → return. The two synchronous SQLite writes (persist + status-transition) happen on the same call stack before the return, with `activeRuns.set` placed between the transition and the `setImmediate` schedule so a failed transition can't leave a stale active-runs entry behind.

`ship` (sync) shares the same factoring: it runs `prepareRun + markRunStarted + activeRuns.set` identically, then awaits the continuation rather than fire-and-forgetting it. The wait is implemented by wrapping `setImmediate` in a deferred Promise:

```ts
const result = await new Promise<ShipOutput>((resolve, reject) => {
  setImmediate(() => executeAndFinalize(ctx, prep).then(resolve, reject));
});
```

That keeps `ship` going through the same `setImmediate` path as `startShip` (the shared code path is the entire body, not just `prepareRun`) so timing semantics are identical. No polling loop; no second copy of the continuation logic. Net behavior change for `ship`: none — it still resolves with `ShipOutput` at terminal state.

Rationale: two named methods are clearer than a `mode: "sync" | "async"` parameter. The CLI keeps importing exactly what it imports today; the MCP handler imports the new method. Tests for each method are independent.

Rejected: implementing `ship` as `startShip + waitForTerminal` *as separate calls from the caller's perspective*. That would expose the deferred-Promise mechanism to callers and force them to coordinate. Inlining the wait inside `ship` keeps the caller-visible surface unchanged (one method call, one resolved `ShipOutput`) while sharing 100% of the underlying code path with `startShip`.

### ED-2 — Background-continuation error path is the V1 failure path

V1's `executeAndFinalize` already catches typed run failures internally (via `finalizeFailure`, which updates the row + phase to `failed`, writes `result.json` with the error message, and removes the entry from `activeRuns`) and resolves rather than rejects. The background continuation therefore inherits V1's "errors land as durable `failed` state" guarantee without us re-implementing it.

The new piece is a top-level `.catch()` on the un-awaited promise as a **safety net only** — it fires solely if `finalizeFailure` itself throws (e.g. the SQLite handle is gone, the artifacts dir is unwritable). Under normal failures the catch never runs because `executeAndFinalize` already resolved. The catch logs at debug level; if it fires, the durable state is whatever `finalizeFailure` managed before it threw — `get_workflow_run` will reflect that. Node's unhandled-rejection guardrails are also satisfied (the implementation plan adds a step to verify `executeAndFinalize` has no early-exit path that skips `finalizeFailure`).

Specifically:

```ts
const start = await prepareRun(ctx);                        // throws ⇒ no row, startShip rejects
markRunStarted(ctx, start);                 // sync SQLite write; throws ⇒ no
                                                            //   activeRuns entry to clean up
activeRuns.set(start.workflowRunId, ...);                   // register controller AFTER transition
                                                            //   so a failed transition can't leak
setImmediate(() => {
  executeAndFinalize(ctx, start).catch((err) => {
    // executeAndFinalize already runs finalizeFailure for typed errors and resolves.
    // This .catch is a safety net for the case where finalizeFailure itself threw
    // (lost SQLite handle, unwritable artifacts dir, etc.). Log + drop.
    logger.debug("ship-start: background continuation rejected after finalize", err);
  });
});
return { workflowRunId: start.workflowRunId, status: "running" };
```

Note the registration order vs the V1 sync `ship`: there is no concurrency window between `markRunStarted` and `activeRuns.set` (both run on the same synchronous call stack with no `await` between them), so registering after the transition closes the failure-leak hole without opening any cancel-race hole. A cancel arriving during the `await prepareRun(...)` window finds no row and no activeRuns entry — `cancelRun` reports "not found," which is the V1 behavior. A cancel arriving after `setImmediate` fires the continuation finds both the row (in `running`) and the controller in `activeRuns` — the abort signal is observed by the continuation's call into `cursor.run({ signal, ... })` per V1 ED-2.

### ED-3 — `shipStartOutputSchema` is a new `@ship/mcp` export

The MCP boundary's "every tool ships an input + output schema" contract (V1 phase 8) requires a Zod schema for the new shape:

```ts
export const shipStartOutputSchema = z.object({
  workflowRunId: workflowRunIdSchema,
  status: z.literal("running"),
});
export type ShipStartOutput = z.infer<typeof shipStartOutputSchema>;
```

The `status` field is narrowed to `z.literal("running")` rather than the broader `workflowStatusSchema` because `startShip` always returns `running` by design (per F1 — the `pending → running` transition happens synchronously inside `startShip` before the response). Narrowing here means a future implementation that accidentally returns a different status fails Zod validation at the boundary, not silently in production. Callers who want the live status poll `get_workflow_run`.

This sits next to `shipOutputSchema`, exported from `@ship/mcp` and re-imported by `mcp-server`. The MCP tool handler validates against `shipStartOutputSchema` before sending; the CLI continues to use `shipOutputSchema`.

### ED-4 — No `Phase.kind` change

The implement phase row stays exactly as V1 writes it (`kind = "implement"`, `status = "running"`). Async return doesn't add a new phase shape; it changes when the *tool handler* returns relative to phase completion.

### ED-5 — Tests against the same fake-runner harness

The new `startShip` unit test fixture is the V1 fake-runner harness with one new helper: a "scripted delay" mode that lets the test wait on the background continuation completing (or being cancelled) deterministically. No real timing. Pattern mirrors V1 phase 4 (test-harness).

## Validation plan

### Unit tests (Vitest)

- `core`: `startShip` returns `{ workflowRunId, status: "running" }` immediately; `activeRuns` is populated before return; background continuation completes asynchronously and updates the row to terminal; failure in continuation is captured by `finalizeFailure` and reflected in `get_workflow_run`.
- `core`: cancellation arriving 0ms / 50ms / mid-run after `startShip` returns reaches the SDK run via the existing signal path. Three scenarios.
- `core`: `ship` (sync) behavior is unchanged — existing tests pass without modification.
- `mcp`: `shipStartOutputSchema` parses valid input and rejects invalid input. ULID regex coverage for `workflowRunId`.
- `mcp-server`: `ship` tool handler returns the start shape, not the full output shape. Uses `InMemoryTransport` like V1 phase 8.

### Integration tests

One new test under `e2e/integration/` (subprocess + real disk + fake cursor):

1. Send a `tools/call` for `ship` with a known fixture task doc.
2. Assert the response is `{ workflowRunId, status: "running" }` within < 1s wall-clock.
3. Poll `get_workflow_run` until `isTerminal(status)`.
4. Assert terminal status is `succeeded` and `artifacts.{prompt,events,result}Path` are all populated.

### L3 (live e2e, opt-in via `SHIP_LIVE=1`)

Optional. The existing `e2e/scenarios/` live harness gets one new scenario that mirrors the integration test against the real Cursor SDK, asserting the same shape + that the tool returns in < 1s while the underlying run takes the usual 90–200s.

### Acceptance for the phase

- Both PRs (this doc, then the impl) merged on main.
- Existing `make check` + integration suite green on ubuntu + windows CI.
- A manual `mcp__ship__ship` invocation from a real MCP client (Claude Code or Cursor) returns in < 1s and yields the same `workflowRunId` `get_workflow_run` then resolves terminal on.
- Dogfood: one V2-style task ships using only `mcp__ship__ship` + `mcp__ship__get_workflow_run` without falling out of any tool-call timeout.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cancel-before-register race | A cancel arriving in the < 1ms between `startShip` returning and the background continuation registering its controller no-ops silently | `activeRuns.set(...)` happens **inside** `startShip` on the same synchronous call stack as the `setImmediate(...)` schedule — there is no async window between them, so the continuation's first observable behavior already has the abort signal attached. Test scenario covers this explicitly. |
| Stale `activeRuns` entry after a failed transition | If `markRunStarted` threw *after* `activeRuns.set`, the active-runs map would point at a never-fired continuation | Per ED-2's revised ordering, `activeRuns.set` runs **after** the transition. If the transition throws, the map stays clean; if the transition succeeds, registration follows immediately on the same call stack. |
| Un-awaited promise leaks an unhandled rejection | Node process logs a confusing error; CI might fail strict-mode | The `.catch()` in ED-2 is the explicit handler. `finalizeFailure` is responsible for durable state; the catch only logs. Unit test asserts no unhandled rejection on a forced failure. |
| Existing MCP clients (rare) that consumed the sync shape break | Workflow surfaces stop working for them | The break is documented in the impl PR's changelog. The only known consumer pattern is "agent calls `ship`, times out at 60s, polls `get_workflow_run`" — already broken on the response side; this phase makes the timeout go away. Direct-from-Inspector human callers are non-load-bearing. |
| Background continuation outlives the MCP server process | If the MCP client disconnects mid-run, the run may keep going after stdin closes (V1 chip #7 territory) | Out of scope for this phase. V1 chip "mcp-server stdin-disconnect" is already filed and tracked; the fix for that lands in its own PR and composes cleanly with this one. |
| Doubled latency footprint if `prepareRun` itself is slow | `startShip` is no longer "fast" if validation + DB writes block for hundreds of ms | `prepareRun` is two SQLite writes + filesystem validation. V1 measurements show < 50ms typical. If a future change makes it slower, the design here doesn't paper over it — we'd revisit. |
| Future SSE / progress responses obsolete this design | We ship async-return now, then later prefer streaming | The two are composable. `ship` could later emit progress notifications between `startShip` returning and `get_workflow_run` reaching terminal; clients that ignore notifications keep working. No design rework needed. |

## Out of scope

- CLI changes. `ship ship` stays sync.
- New `Phase.kind` values. Implement-phase row is unchanged.
- Streaming MCP responses / progress notifications.
- V1 chip "mcp-server stdin-disconnect" — its own PR, composes with this one but doesn't depend on it.
- Cloud runtime.
- Documentation for V2 phases 02–04 (open_pr, review, ci_fix). Each is its own phase doc.

## Open questions

1. ~~**Background-continuation primitive: `queueMicrotask` vs `setImmediate`?**~~ **Resolved in this revision:** `setImmediate`. Explicit "after this turn of the event loop" semantics keep the cancellation test surface deterministic; the difference vs `queueMicrotask` is on the order of a tick and not measurable in any user-visible way. Pinned in the Tradeoffs table + the ED-2 code sketch.
2. **Should the start response include `cursorRun: null` placeholders?** Default: no. The shape is `{ workflowRunId, status }` only. Adding placeholders that are always null/empty is noise.
3. **Should we add a `started_at` timestamp to the start response?** Default: no — `get_workflow_run` already returns `createdAt`; callers can read it from there. Adds one more field to keep in sync otherwise.

## Implementation plan

After this doc is reviewed and merged:

1. **Add `shipStartOutputSchema` to `@ship/mcp`.** Plus exported `ShipStartOutput` type with `status: z.literal("running")` per ED-3.
2. **Add `startShip` to the `ShipService` interface and implementation in `@ship/core`.** Add the method to the `ShipService` interface (`packages/core/src/service.ts`) so `mcp-server` can call it through the typed contract — without this step the mcp-server import will fail to typecheck. Then factor `shipImpl` into `prepareRun` + the existing `executeAndFinalize`, extracting the `pending → running` transition into its own helper so `startShip` can call it synchronously before yielding. Wire the un-awaited continuation + safety-net `.catch()` per ED-2.
3. **Verify `executeAndFinalize`'s catch contract.** Before relying on the safety-net wording in ED-2, audit `packages/core/src/service.ts` `executeAndFinalize` (and its call graph into `finalizeFailure`) to confirm there's no early-exit path that returns / throws *before* `finalizeFailure` runs. If one exists, either fix it or update ED-2 to document the exposure. This is a doc-confirmation step, not a code change.
4. **Update the `ship` MCP tool handler in `@ship/mcp-server`.** Call `startShip` instead of `ship`. Validate output with `shipStartOutputSchema`.
5. **Update unit tests** for the three packages above.
6. **Add one integration test** under `e2e/integration/` per the Validation section.
7. **Update relevant JSDoc** on the changed exports.
8. **Land as one PR.** Estimated weighted budget ~210 LOC — single PR per the V1 sizing rule. If the diff comes in heavier than the "amazing" band, the natural split is "core + mcp changes" / "integration test" — but the small expected size makes the split unlikely to be worth the second review.

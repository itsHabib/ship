**Status**: draft — ready for `ship.ship`
**Owner**: @michael (human:mh)
**Date**: 2026-06-20
**Related**: dossier task `agent-runner-seam-extract` (id `tsk_01KVH5KD73DXX611NFQKR0JBXE`); TDD [../spec.md](../spec.md) §3, §6, §9 (Phase 1a), §11; design review PR #145.

# Rename CursorRunner→AgentRunner + extract `@ship/agent-runner` with an EventProjection seam

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production — new pkg | `packages/agent-runner/src/*`: `AgentRunner` interface, handle/promise/cancel state machine, `FailureCategory` classification policy, duration formatters, error taxonomy, `FakeAgentRunner`, the `EventProjection` interface, neutral `McpServerConfig`/`AgentDefinition` interfaces — much **moved** from cursor-runner | ~430 | 430 |
| Production — cursor-runner | rename `CursorRunner`/`CursorRun*`→`AgentRunner`/`AgentRun*` across `runner.ts`/`_shared.ts`/`classify-failure.ts`/`local-runner.ts`/`cloud-runner.ts`/`room-runner.ts`/`index.ts`; add `CursorEventProjection`; re-point `_shared.ts`/`classify-failure.ts` decoders through the projection | ~220 | 220 |
| Production — consumers | import-name shifts in `core`/`store`/`workflow`/`mcp`/**`cli`** (review — `cli/src/bin.ts` imports `CursorRunner`/`FakeCursorRunner`); **+ a real change at core's classify call site** (ED-4 / step 4), not "names only" | ~70 | 70 |
| Tests | re-fixtured cursor-runner tests + the projection-equivalence test + golden `events.ndjson` fixtures | ~400 | 200 |
| **Total** | | | **~890** |

Band: **stretch** (<1000) — mostly mechanical moves + a mechanical rename. If it crosses 1000 at impl time, split per the Implementation-plan (PR1 = package extract + projection; PR2 = rename + re-point + consumers).

## Functional

Generalize the runner seam so a second provider can sit behind it, with **zero behavior change for cursor** (additive only — nothing removed).

1. **New package `@ship/agent-runner`** holding the provider-neutral mechanism, lifted out of `@ship/cursor-runner`:
   - The `AgentRunner` interface (renamed from `CursorRunner`) — `run` / `attach` / optional `downloadArtifact?`, unchanged method shapes.
   - `AgentRunInput` / `AgentRunResult` / `AgentRunHandle` / `AgentRunAttachInput` (renamed from `CursorRun*`), with the event type generalized from `SDKMessage` to a provider-neutral `AgentEvent`.
   - The handle/promise/cancellation state machine (the `#buildHandle` orchestration — `terminated`/`cancelInitiated` guards, signal listener attach/detach, the single `cancelInternal` funnel with retry-on-transient).
   - The `FailureCategory` classification **policy** (the `classify-failure.ts` decision logic + ratios + the `DETAIL_BUILDERS` table) and the duration/age formatters.
   - The error-class taxonomy structure (the `RunFailedError` umbrella + cause-stringifiers; the `MissingApiKeyError` precondition shape).
   - `FakeAgentRunner` (the scriptable double — already SDK-free).
   - The **`EventProjection`** interface (the one new seam): `eventKind`, `toolCallId`, `toolCallStatus` (normalized `ToolCallStatus` vocabulary), `toolCallName`, `commandArg`, `timestamp`, `statusMessage`, `resultText`, `terminalStatus` (returns `undefined` on non-terminal events).
   - **Neutral `McpServerConfig` / `AgentDefinition` interfaces** — these come from `@cursor/sdk` today, so the neutral package **cannot** re-export them. Define structural equivalents here (stdio/http MCP config shape + the subagent-definition shape); consumers never destructure them, so this is a thin re-typing.
2. **`@ship/cursor-runner` depends on `@ship/agent-runner`** and supplies:
   - `CursorEventProjection` — reads cursor `SDKMessage` shapes through the existing `_shared.ts` accessors, **normalizing** cursor's raw spellings (uppercase `ERROR`/`EXPIRED` status events, lowercase `error`/`failed` tool-call statuses) to the canonical `ToolCallStatus` vocabulary. Normalization is the projection implementor's contract — the classifier never sees raw cursor spellings.
   - `Local`/`Cloud`/`Room` runners implement `AgentRunner`; map cursor's SDK MCP/agent config to/from the neutral interfaces.
   - `_shared.ts` / `classify-failure.ts` read events through the injected projection instead of bracket-indexing `eventRecord()` directly.
   - The `@cursor/sdk` import-isolation test stays green, now scoped to cursor-runner.

## Tradeoffs

- **Extract a neutral package vs. duplicate mechanism into each runner** → extract (TDD D3). Pure mechanism with no SDK dependency; one home stops the two providers from drifting; matches composition-of-single-responsibility-layers.
- **Projection seam vs. translate Claude into `SDKMessage` shape** → projection (TDD D2). Keeps cursor's enum spellings + the SQLite-lock regex out of the shared classifier (policy vs. mechanism).
- **Enforced normalization (a `ToolCallStatus` union) vs. free `string`** → enforced. Copilot/@claude review: a free `string` lets a provider leak raw spellings and defeats the seam. Normalization lives in each projection.

## EDs (engineering decisions)

- **ED-1: `AgentEvent` stays opaque to consumers.** `core`/`store` only forward it (ndjson write + heartbeat); structure is read *only* via `EventProjection`. The `onEvent` pass-through bodies in `core` stay byte-for-byte identical.
- **ED-2: include `toolCallId` in the projection.** Cursor's classifier reconciles a `running` tool via `call_id` (`finalStatusByCallId`/`lastRunningToolCall`); omitting it would regress the zero-change gate (@codex P2).
- **ED-3: the neutral package owns `McpServerConfig`/`AgentDefinition` interfaces.** It cannot re-export `@cursor/sdk`'s without pulling a cursor dependency (Copilot/@claude). Fully neutralizing field-by-field for Claude is Phase 2's concern.
- **ED-4: the result mapper is provider-LOCAL, not shared (review).** Only `classifyFailure`/`buildFailureDetail` + the handle state machine + error taxonomy + fake move to `@ship/agent-runner`. `mapRunResult`/`mapErrorResult`/`buildTerminalErrorMessage` (~130 lines of cursor-specific terminal-error construction in `_shared.ts` — ordering-sensitive `toolCall ?? statusMessage` selection, the SQLite contention-hint regex, the `.toUpperCase()` of status) **stay in `@ship/cursor-runner`**; Claude gets its own mapper in Phase 2. The "shared mechanism" is the classifier + state machine + taxonomy + fake, NOT the `RunResult`→`AgentRunResult` mapper.
- **ED-5: `service.ts` is a third event-shape reader (review).** Beyond `_shared.ts`/`classify-failure.ts`, `core/service.ts` reads `events.ndjson` off disk (`sdkStatusFromRecentEvents`/`parseRecentEventsNdjson`) to recompute `sdkTerminalStatus` for the `get_workflow_run` diagnostics view — outside the runner packages + the projection. Cursor is unchanged, but a future Claude run would get a wrong/empty `sdkTerminalStatus` here. **Fix in this task:** prefer the `sdkTerminalStatus` the runner already persists to `result.json` (already read at parse time) and drop the ndjson re-derivation, OR make a per-provider projection reachable from core's disk path. Inventory + decide; this is the third reader the "two files" premise missed.

## Validation

- `grep -r "instanceof CursorRunner"` returns nothing before merge (duck-typed today; one missed `instanceof` passes `tsc`, fails at runtime — @claude).
- No package outside `@ship/cursor-runner` imports `@cursor/sdk` (isolation test passes).
- **All existing cursor runner/classifier tests pass unmodified.**
- **Projection-equivalence test (the gate) — concrete plan (review):** (1) **before** the move, snapshot the current `classifyFailure`/`buildFailureDetail` OUTPUT (category + detail JSON) for the fixture corpus into a **committed expectation file** — after the rename there's no in-tree "old" classifier to diff against, so the post-refactor test asserts against that frozen baseline. (2) The corpus must trigger every taxonomy path: `contention` (database-is-locked), `timeout-near-cap` (EXPIRED), `agent-collapse-on-running-tool` (call_id reconciliation), `logic` (failed tool_call), `sdk-throw`, `unknown`. (3) Source: the existing synthetic table-driven cases in `classify-failure.test.ts` already exercise every branch — derive the baseline from those; real `events.ndjson` fixtures are nice-to-have, not required (no real corpus exists in-repo today). The point is an *executable* gate, not an aspirational one.
- Full `make check` (incl. the coverage gate) green on **ubuntu + windows**.

## Risks

- **Rename blast radius into `service.ts`.** The type-name change touches multiple references in `packages/core/src/service.ts` (`selectRunner`, `buildShipCursorRunInput`, the `_CloudKeysMatch`/`_RoomKeysMatch` asserts, the `AgentDefinition`/`McpServerConfig` imports). This file is **also touched by the sibling task `decursor-identity`** — see the driver manifest's conflict note; this task lands first, the sibling rebases on it.
- **Coverage gate (cursor-runner ≥85% branch).** Moved code keeps its tests; the new projection indirection needs branch-covering tests so the gate holds.
- **Over-large PR.** If weighted-LOC crosses the stretch band, split into PR1 (package + projection) / PR2 (rename + re-point + consumers).

## Out-of-scope

- The Claude runner / `@ship/claude-runner` (Phase 2).
- The `provider` selector / capability map / schema threading (Phase 2b).
- The identity de-cursoring + `provider` column (sibling task `agent-runner-decursor-identity`, Phase 1b).
- Field-by-field neutralization of the MCP/agent config shapes for Claude compatibility (Phase 2a checklist).

## Implementation-plan

1. **Scaffold `@ship/agent-runner`** (package.json, tsconfig, vitest) and move the provider-neutral mechanism in: state machine, classification policy, formatters, error taxonomy, `FakeAgentRunner`. Re-export the `@ship/workflow` types it needs (`ModelSelection`, `FailureCategory`, `ArtifactRef`).
2. **Define `EventProjection`** (+ the `ToolCallStatus` normalized union + neutral `McpServerConfig`/`AgentDefinition` interfaces); re-point `_shared.ts` + `classify-failure.ts` to read through a passed-in projection.
3. **Rename** `CursorRunner`/`CursorRun*` → `AgentRunner`/`AgentRun*` in cursor-runner; add `CursorEventProjection` (the existing accessors, normalized); wire it into the runners. Keep the isolation test green.
4. **Update consumers** to the renamed types. Mostly import-name shifts — **but the classify call site in `core` is a real logic change, not "names only"** (review): `service.ts` imports `classifyFailure`/`buildFailureDetail` and calls them with the event array (`classifyFailedRun`/`classifyThrownFailure`). Bind the projection there: either keep a `CursorEventProjection`-bound `classifyFailure` re-exported from `@ship/cursor-runner` so core stays events-only, OR move it to `@ship/agent-runner` and have core thread the projection resolved by the run's `provider`. Pick one and write it down. (Also resolves the file-location ambiguity: `classify-failure.ts` logic → `@ship/agent-runner`; the cursor projection → `@ship/cursor-runner`.)
5. **Tests**: re-fixture; add the projection-equivalence test over real golden `events.ndjson`; restore coverage.

*(If steps 1–2 + 3–5 together exceed the stretch band, ship steps 1–2 as PR1 and 3–5 as PR2.)*

# Phase: rooms routing + MCP surface (PR-S2)

**Status**: in progress
**Owner**: @michael (human:mh) / claude-code
**Date**: 2026-06-07
**Spec**: [`../spec.md`](../spec.md) — the contract. PR-S2 slice of Implementation-plan step 3. Stacks on PR-S1 (`RoomCursorRunner`).

## Scope

| Bucket | Files | Weighted |
|---|---|---|
| source (1×) | `packages/workflow/src/workflow.ts` (runtime enum), `packages/core/src/service.ts` (routing + doc-resolve + branches surfacing + drift check), `packages/core/src/errors.ts` (`RoomRunnerNotConfiguredError`), `packages/core/src/default-wiring.ts` (default `roomCursor`), `packages/mcp/src/mcp.ts` (`roomRunSpecSchema` + `shipInputSchema` + `branches` on `get_workflow_run`) | ~150 |
| tests (0.5×) | `service.test.ts` (rooms routing + branches surface), `mcp.test.ts` (schema) | ~70 |
| docs (0×) | this doc | 0 |

**~220 weighted — amazing band.**

## Functional

### Routing (`@ship/core`)
- `resolvePersistedRuntime`: `runtime === "rooms"` → persists `cursor_runs.runtime = "rooms"`.
- `selectRunner`: `runtime === "rooms"` → the injected `config.roomCursor`; throw `RoomRunnerNotConfiguredError` when unset (mirrors `CloudRunnerNotConfiguredError`).
- `ShipServiceConfig.roomCursor?: CursorRunner`; default wiring constructs `new RoomCursorRunner()`.
- `buildShipCursorRunInput`: `runtime === "rooms"` → forwards `{ runtime: "rooms", room }`.
- `prepareRun` / doc resolution: rooms is treated like cloud — **workdir optional**, doc resolved local-first / remote-fallback (`resolveValidatedDocForCloud`). `repo` derived from `room.repos[0].url` when not explicit. `room` is persisted into the implement phase's `input_json` for forensics (rooms has no resume path, so it is never read back).
- A `_RoomKeysMatch` compile-time assertion keeps `ShipInput["room"]` keys ≡ `RoomRunSpec` keys (mirrors the existing `_CloudKeysMatch`).

### `branches[]` surfaced via `get_workflow_run`
Per spec § Routing ("`branches[]` is persisted on the run row and surfaced via `get_workflow_run`"): `enrichWorkflowRunView` reads `branches` from the terminal `result.json` (the existing persistence — no DB migration) and attaches them to the `GetWorkflowRunOutput`, defensively shape-validated. This makes `/work-driver` (and the operator) read `branches[0].branch` straight off the `get_workflow_run` MCP tool to open the PR with `gh pr create`, instead of parsing an artifact file off disk.

**Decision note for reviewers — spec tension:** the spec's ED-2 ("rooms == cloud") and the cloud L3 e2e comment ("`ShipOutput.cursorRun` has no `branches` field by design") describe `ShipOutput` (the blocking `ship` return). This change adds `branches` to `GetWorkflowRunOutput` (the async-poll return) — a *different* surface — and applies it to **both** cloud and rooms, so rooms stays exactly like cloud (ED-2 holds) while satisfying § Routing's "surfaced via `get_workflow_run`". The field is optional + additive (only present when a terminal `result.json` carries a non-empty `branches`), so it's backward-compatible. Reading from `result.json` (not a new column) keeps it a zero-migration change.

### MCP surface (`packages/mcp`)
- `roomRunSpecSchema` (structural twin of `RoomRunSpec`): `repos` 1-tuple (`url` + optional `startingRef`), optional `image` / `pushBranch`, `.strict()`.
- `shipInputSchema`: `runtime` accepts `"rooms"`; add `room`; refinements — `room` required when `runtime === "rooms"`; `workdir` + `repo` required only for local (cloud and rooms derive/skip them).
- `getWorkflowRunOutputSchema`: optional `branches: runBranchRefSchema[]`.

## Out-of-scope
- The `RoomCursorRunner` itself (PR-S1).
- Reviving `open_pr` — removed from ship; PR opening stays downstream (ED-3), same as cloud `autoCreatePR: false`.
- Cloud resume parity for rooms — rooms VMs are disposable (ED-5).
- L3 real-microVM e2e — gated on the rooms-host VM (down); tracked as a follow-up dossier task.

## Validation
- `service.test.ts` (L2): `ship({ runtime: "rooms", room: {...} })` routes to the injected `roomCursor` (local + cloud runners untouched); `cursor_runs.runtime === "rooms"` persists; the fake's `branches[0].branch` is readable via `getRun().branches[0].branch`; `RoomRunnerNotConfiguredError` when `roomCursor` unset (before any persistence); rooms without workdir derives repo + uses the cloud-sentinel worktree.
- `mcp.test.ts`: `shipInputSchema` accepts a rooms input, rejects `runtime: "rooms"` without `room`, allows omitted workdir/repo for rooms; `getWorkflowRunOutputSchema` accepts `branches`.
- `make check` green.

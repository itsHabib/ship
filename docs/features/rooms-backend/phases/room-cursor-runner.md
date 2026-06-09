# Phase: RoomCursorRunner (PR-S1)

**Status**: in progress
**Owner**: @michael (human:mh) / claude-code
**Date**: 2026-06-07
**Spec**: [`../spec.md`](../spec.md) — the contract. This doc is the PR-S1 slice of its Implementation-plan step 2.

## Scope

| Bucket | Files | Weighted |
|---|---|---|
| source (1×) | `packages/cursor-runner/src/room-runner.ts` (new), `runner.ts` (`RoomRunSpec` + `runtime: "rooms"`), `errors.ts` (6 new errors), `index.ts` (exports) | ~270 |
| tests (0.5×) | `room-runner.test.ts` (new), `fake.test.ts` (rooms-path test) | ~95 |
| docs (0×) | this doc | 0 |

**~365 weighted — ideal band.** PR-S2 (core routing + MCP schema) ships separately.

## Functional

`RoomCursorRunner implements CursorRunner` as a **subprocess orchestrator over the `rooms` binary** (ED-1) — it never calls `@cursor/sdk` in-process (the SDK runs inside the microVM). It mirrors `CloudCursorRunner`'s pipeline shape but the substrate is a `rooms run` subprocess + on-disk contract artifacts rather than the cloud SDK.

### `run(input)`

1. Guard `input.runtime === "rooms"` (`WrongRunnerError`) and `input.room` present (`MissingRoomSpecError`); `room.repos` must be a single-element array (`InvalidRoomReposError`) — mirrors cloud.
2. Synthesize opaque IDs: `agentId = "room-<uuid>"`, `runId = "run-<uuid>"`. No SDK agent exists, so these are never round-tripped (attach is unsupported).
3. Create a per-run host temp dir (`<os.tmpdir()>/ship-rooms-<uuid>/`) containing the rendered task file and an `out/` subdir handed to `--out`. (The task file lives **outside** `out/` because rooms clears `--out` at run start.)
4. Spawn:
   ```
   rooms run --runner cursor --image <room.image ?? defaultImage> --repo <room.repos[0].url>
     --base-sha <room.repos[0].startingRef ?? "HEAD"> --task <taskfile> --model <input.model.id>
     --push-branch <room.pushBranch ?? derived> --out <out/>
   ```
   The rooms CLI requires `--image` (no default), so `run()` rejects with `MissingRoomImageError` when neither `room.image` nor a configured `defaultImage` is set — a clear pre-run error instead of an opaque clap failure inside the subprocess. `GH_TOKEN` (← `GH_TOKEN ?? GITHUB_TOKEN`) + the inherited `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` go on the **subprocess env**, never argv.
5. Derived push branch: `rooms/<slug(agentName) || "run">-<short-uuid>` (`agentName` is conventionally `ship/<workflowRunId>`).
6. On subprocess exit, read `out/`: assert `result.json.schema_version === 1` (pin the literal — bail with `RoomSchemaVersionError` on drift), **replay `events.ndjson` through `onEvent`**, **then** resolve `handle.result`. Replay-before-resolve mirrors the local/cloud live-stream ordering with a terminal replay.
7. Build `CursorRunResult { status, summary (summary.md), durationMs: ended_at − started_at, branches: pushed_branch ? [{ repoUrl, branch: pushed_branch }] : [] }`; `errorMessage` (from summary/result.json) + `sdkTerminalStatus` (raw rooms status) when failed.
8. Success → remove the temp dir; failure → leave it for debugging.

### `attach` / `downloadArtifact`

- `attach` rejects with `RoomResumeNotSupportedError` (ED-5; rooms VMs are disposable — mirrors `LocalCursorRunner.attach`).
- No `downloadArtifact` (omitted, like local).

### Cancellation

`handle.cancel()` and `input.signal` abort both kill the subprocess (idempotent, no-op after terminal) — same guard shape as the local/cloud runners.

## Tradeoffs / decisions

- **Inject `spawn` (default = `node:child_process` spawn) for testability.** The runner builds argv + env, the injected spawn captures them and writes the contract artifacts to `--out`; the runner reads them back with real `node:fs`. This keeps the arg-surface and artifact-parse logic under unit test without a real rooms binary or microVM. `roomsBin` (default `"rooms"`) + `defaultImage` are also constructor options.
- **Status mapping is vocabulary-tolerant.** rooms' `result.json.status` strings map to ship's `succeeded|failed|cancelled`; unknown strings fall back to `exit_code === 0 ? succeeded : failed` so a contract wording change degrades gracefully rather than mis-reporting.
- **Schema drift rejects the result Promise** (not a silent `failed`) — a `schema_version` mismatch is a harness/contract failure, surfaced as a `CursorRunFailedError` subclass that core folds into the run's `errorMessage` (same path as a cloud pre-run failure).

## Out-of-scope (this PR)

- Core routing / `roomCursor` wiring / `RoomRunnerNotConfiguredError` → PR-S2.
- MCP `shipInputSchema` `runtime: "rooms"` → PR-S2.
- `@ship/workflow` `cursorRunRuntimeSchema += "rooms"` (persistence) → PR-S2.
- Live event streaming, attach/resume, multi-repo, rooms primitive verbs (`create`/`exec`/`destroy`) — spec Out-of-scope.
- L3 real-microVM e2e — gated on the rooms-host VM (down); tracked as a follow-up.

## Validation

- `room-runner.test.ts`: argv shape (flags + `--base-sha HEAD` default + derived push-branch), `GH_TOKEN` on env not argv, success → `CursorRunResult` (branches/durationMs/summary), `events.ndjson` replayed through `onEvent` before `result` resolves, `schema_version` drift → `RoomSchemaVersionError`, failed-status mapping + `errorMessage`, missing `room`/multi-repo guards, `attach` rejects, cancel kills the child.
- `fake.test.ts`: `FakeCursorRunner` accepts a rooms-shaped input and replays a branches-populated result (the double used by PR-S2's L2 routing test).
- `make check` green (typecheck + strict lint + format + unit).

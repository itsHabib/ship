**Status**: draft
**Owner**: @michael (human:mh)
**Date**: 2026-05-31
**Related**: dossier task `ship-rooms-backend` (id: `tsk_01KSBE4EWNZJ69GGGSYK7VKFRK`), rooms `cursor-sdk-runner` (merged — [rooms#37](https://github.com/itsHabib/rooms/pull/37)), `packages/cursor-runner/src/runner.ts` (the `CursorRunner` contract), `cloud-runner.ts` (the mirror)

# rooms backend — `RoomCursorRunner` design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| ship source (1×) | `packages/cursor-runner/src/room-runner.ts` (new), `runner.ts` (`RoomRunSpec` + `runtime: "rooms"`), `_shared.ts`/`errors.ts` touch | ~260 | 260 |
| ship source (1×) | `packages/core/src/service.ts` (route `runtime === "rooms"`), `packages/mcp/src/mcp.ts` (`shipInputSchema` accepts `rooms`) | ~90 | 90 |
| rooms source (1×, separate repo/PR) | `src/runner.rs` (`--push-branch`: commit + push over the existing SSH), `--out` host collect; `main.rs` flags | ~120 | 120 |
| Tests (0.5×) | `FakeCursorRunner` rooms path + routing tests; rooms-side push unit + a gated e2e | ~180 | 90 |
| Docs (0×) | this spec | — | 0 |

**~560 weighted, ideal band — but it spans two repos and three natural PRs (see Implementation-plan); ship each separately.**

## Goal

`ship.ship { runtime: "rooms", room: { repos: [{ url }] }, … }` drives a cursor agent **inside a disposable rooms microVM**. The room is self-contained: clone → agent edits → **commit + push a branch** → report terminal state. ship reads the report and opens the PR through its existing path. Net: **rooms is "our self-hosted cloud"** — same contract and PR flow as `CloudCursorRunner`, but the agent runs on our Firecracker host instead of Cursor's servers.

This is the capstone that makes rooms *used*: after this, `/work-driver` can fire `ship.ship { runtime: "rooms" }` and a real task lands a real PR via a microVM.

## The model: mirror cloud, not local

Decided in design discussion. The room must **persist its own work** (the whole point of an isolated room is a durable artifact, not loose files), so it pushes a branch — exactly like the cursor *cloud* agent does. Mirror-local (copy files back, host commits) was rejected: it couples every run to a host-side git environment and makes the room a glorified subprocess.

Consequences, all of which fall out of the existing cloud path:
- `RoomCursorRunner` returns a `CursorRunResult` with `branches[] = [{ repoUrl, branch }]` populated — the same field `CloudCursorRunner` fills from `result.git`.
- ship's `open_pr.resolveHead` already reads `branches[0].branch` when `runtime === "cloud"`; extend that read to `"rooms"` and **PR opening is reused verbatim — no new PR code.**
- The room only needs a **push-scoped token** (contents:write); the PR is opened host-side with ship's existing `gh` auth. Least privilege in the disposable VM.

## Functional

### Runtime + input
- Extend `CursorRunInput.runtime` to `"local" | "cloud" | "rooms"`. (The dossier task says `backend`, but the code keys everything off `runtime`; one more variant is the consistent move.)
- Add `room?: RoomRunSpec` parallel to `cloud?: CloudRunSpec`:
  ```ts
  interface RoomRunSpec {
    readonly repos: readonly [{ readonly url: string; readonly startingRef?: string }]; // single-repo, like cloud
    readonly image?: string;        // defaults to the host's agent-alpine-cursor.ext4
    readonly pushBranch?: string;   // ship-chosen branch; rooms pushes here. Default: derive from agentName/workflowRunId.
    readonly autoCreatePR?: boolean; // default false — ship opens the PR host-side (see model). true → rooms opens it (needs PR-scope token).
  }
  ```

### `RoomCursorRunner` (`packages/cursor-runner/src/room-runner.ts`)
Implements `CursorRunner`. Unlike Local/Cloud it does **not** call `@cursor/sdk` in-process — it's a subprocess orchestrator over the `rooms` binary:
- `run(input)`: validate `runtime === "rooms"` + `room` present (else `WrongRunnerError` / a new `MissingRoomSpecError`). Spawn:
  ```
  rooms run --runner cursor \
    --image <room.image> --repo <room.repos[0].url> --base-sha <room.repos[0].startingRef> \
    --task <tmpfile(input.prompt)> --model <modelArgFromInput> \
    --push-branch <room.pushBranch> --out <hostdir>
  ```
- Stream + terminal: rooms writes the contract artifacts (`events.ndjson` / `summary.md` / `result.json`) and `--out` collects them to `<hostdir>` before teardown. `RoomCursorRunner` reads them → calls `input.onEvent` per `events.ndjson` line (each line is already an `SDKMessage` under `.event`), and builds `CursorRunResult { status, summary, durationMs, branches: [{ repoUrl, branch }] }` from `result.json` (which gains the pushed-branch field) + `summary.md`.
- `attach`: throws `RoomResumeNotSupportedError` (no resume for v0 — rooms VMs are disposable; mirrors `LocalCursorRunner.attach`).
- No `downloadArtifact` (omitted, like local).

### Routing (`@ship/core`)
- `runtimeLabel(input)` (service.ts:328): add `=== "rooms" ? "rooms"`.
- The `input.runtime === "cloud"` routing branches (service.ts:332/362/453): add a `"rooms"` arm calling the injected `roomCursor` runner; throw `RoomRunnerNotConfiguredError` if unconfigured (mirror `CloudRunnerNotConfiguredError`).
- `ShipServiceConfig.roomCursor?: CursorRunner` (optional, like `cloudCursor`), default `new RoomCursorRunner()`.
- `open_pr.resolveHead`: read `branches[0].branch` for `runtime === "rooms"` too.

### MCP surface (`packages/mcp`)
- `shipInputSchema`: `runtime` accepts `"rooms"`; add the `room` object; cross-field refinement — `workdir` optional for rooms (like cloud; rooms has no host worktree), `repo` derivable from `room.repos[0].url`.

### rooms-side (separate repo — the cross-repo half)
- `rooms run --runner cursor --push-branch <b>`: after the agent + `result.patch`, **commit + push** over the SSH connection rooms already holds — `git checkout -b <b>` (or `-B`), explicit `git add <changed paths>` (NOT `-A` — ship's hard rule, the `.keys~` incident), `git commit -m <msg + Co-authored-by: Cursor>`, `git push origin <b>`. Auth via a push-only token forwarded into the guest the same way `ANTHROPIC_API_KEY`/`CURSOR_API_KEY` are (`SendEnv`/`AcceptEnv`); the tabled `secret-injection-via-vsock` task hardens the channel later.
- `result.json` gains the pushed ref (e.g. `pushed_branch`).
- `--out <hostdir>`: scp `/workspace/out` to the host dir before teardown (the `collect` half) so ship reads `events.ndjson`/`summary.md`/`result.json`. This is the *only* artifact pull-back — no patch is pulled (the push carries the code).

## Tradeoffs
- **Mirror cloud vs mirror local** → cloud (room self-persists; reuses cloud's `branches[]` + `open_pr` path; no host git-env coupling).
- **rooms pushes vs ship pulls a patch** → rooms pushes (the room does the whole job; the code escapes via git, not a file).
- **Push-only token in room vs full `gh`** → push-only; ship opens the PR host-side (least privilege; no `gh` needed in the image).
- **Extend `runtime` vs new `backend` param** → extend `runtime` (consistent with all existing code).
- **One-shot `rooms run` vs compose `create`/`exec`/`destroy`** → one-shot for v0 (the primitive verbs don't exist in rooms yet; the push lives in the already-agent-specific cursor path, so the agnostic core stays clean). Primitive-verb composition is a later refactor.
- **Live event streaming vs terminal replay** → terminal replay for v0 (`onEvent` fired in stream order once `--out` lands; satisfies the fire-and-forget contract). Live tail is a fast-follow (rooms ED-5 deferred it too).

## EDs
- **ED-1: `RoomCursorRunner` is a subprocess orchestrator over the `rooms` binary**, not an `@cursor/sdk` caller. The SDK runs inside the VM (rooms' baked `cursor-runner.js`); ship parses rooms' contract artifacts.
- **ED-2: rooms-shaped result == cloud-shaped result.** `branches[0].branch` populated; `open_pr` and the rest of ship treat a rooms run exactly like a cloud run.
- **ED-3: the room commits + pushes (rooms-driven over SSH, not the LLM); ship opens the PR host-side.** Push-only token in the room; PR-scope creds stay on the host.
- **ED-4: this feature spans both repos.** A rooms PR (`--push-branch` + `--out`) lands first or alongside the ship PRs; the ship side is inert without it.
- **ED-5: no attach/resume for rooms in v0** — VMs are disposable.

## Validation
- **L2 (fake):** a `FakeCursorRunner`-style rooms double; `ShipService.ship({ runtime: "rooms", room: { repos: [...] } })` routes to it, `cursor_runs.runtime === "rooms"` persists, the fake's `branches[0].branch` flows through `events.ndjson` and is readable via `get_workflow_run`. `RoomRunnerNotConfiguredError` when unconfigured.
- **L3 (real microVM, rooms-host, gated):** `ship.ship { runtime: "rooms", room: { repos: [{ url: <fixture> }], pushBranch: "rooms/<x>" } }` → microVM boots `agent-alpine-cursor.ext4` → agent edits → branch `rooms/<x>` pushed to the fixture remote → ship opens the PR → PR contains the change. Asserts the full self-hosted-cloud loop.
- rooms-side: a unit test for the push command construction (explicit-add, branch, trailer); the gated e2e above exercises it live.

## Risks
- **Push token in the disposable VM.** Scoped to contents:write on the one repo; forwarded like the existing API keys for v0; vsock-hardened later. Smaller blast radius than a full `gh` cred.
- **Cross-repo coordination.** The ship side can't run end-to-end until the rooms `--push-branch`/`--out` PR lands. Sequence: rooms PR → ship runner PR → ship routing PR.
- **rooms subprocess reliability / arg surface.** rooms is invoked as a CLI; a flag/contract drift breaks ship silently. Mitigation: pin the rooms invocation behind a small adapter + assert the `result.json` schema_version.
- **Event fidelity.** Terminal replay (not live) for v0; a long run shows no progress until it finishes. Acceptable for v0; live tail is the fast-follow.

## Out-of-scope
- Live event streaming (fast-follow).
- rooms primitive verbs (`create`/`exec`/`collect`/`destroy`) — v0 uses one-shot `rooms run`.
- Attach/resume for rooms.
- Multi-repo rooms runs.
- rooms opening the PR itself (`autoCreatePR: true` path) — designed for, deferred; v0 opens host-side.

## Implementation-plan (PR boundaries)
1. **PR-R (rooms repo):** `rooms run --runner cursor --push-branch <b> --out <hostdir>` — commit + push over SSH (explicit-add, trailer, push-only token via `SendEnv`) + `--out` host collect + `pushed_branch` in `result.json`. Gated e2e on rooms-host. *Lands first.*
2. **PR-S1 (ship):** `RoomRunSpec` + `runtime: "rooms"` on `CursorRunInput`; `RoomCursorRunner` (run → spawn rooms → parse `--out` artifacts → `CursorRunResult`; attach throws; onEvent replay) + `FakeCursorRunner` rooms path + unit tests.
3. **PR-S2 (ship):** core routing (`runtime === "rooms"` → `roomCursor`, `RoomRunnerNotConfiguredError`, `open_pr.resolveHead`) + MCP `shipInputSchema` (`runtime: "rooms"`, `room`, refinements) + the L2 routing test.
4. **e2e:** `ship.ship { runtime: "rooms" }` against a fixture on the rooms-host — the full loop.

Reviewers per repo: `@codex` + `@claude` (+ Copilot). This doc goes up as its own reviewed PR before any impl (ship design-phase convention).

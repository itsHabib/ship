**Status**: ready for impl — rooms side (PR-R) merged; ship side (PR-S1/S2) pending
**Owner**: @michael (human:mh)
**Date**: 2026-05-31 (refreshed 2026-06-03 — rooms side merged; as-built interface)
**Related**: dossier task `ship-rooms-backend` (id: `tsk_01KSBE4EWNZJ69GGGSYK7VKFRK`); rooms `cursor-sdk-runner` ([rooms#37](https://github.com/itsHabib/rooms/pull/37)) + `--push-branch` ([rooms#39](https://github.com/itsHabib/rooms/pull/39)) + `--out` ([rooms#40](https://github.com/itsHabib/rooms/pull/40)), all merged; `packages/cursor-runner/src/runner.ts` (the `CursorRunner` contract), `cloud-runner.ts` (the mirror)

# rooms backend — `RoomCursorRunner` design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| ship source (1×) | `packages/cursor-runner/src/room-runner.ts` (new), `runner.ts` (`RoomRunSpec` + `runtime: "rooms"`), `_shared.ts`/`errors.ts` touch | ~260 | 260 |
| ship source (1×) | `packages/core/src/service.ts` (route `runtime === "rooms"`), `packages/mcp/src/mcp.ts` (`shipInputSchema` accepts `rooms`) | ~90 | 90 |
| rooms source (separate repo) | `--push-branch` + `--out` — **MERGED** (rooms#39 + rooms#40) | — | 0 |
| Tests (0.5×) | `FakeCursorRunner` rooms path + routing tests (rooms-side already tested) | ~120 | 60 |
| Docs (0×) | this spec | — | 0 |

**Ship side ~410 weighted (rooms side already merged), ideal band — two ship PRs (see Implementation-plan); ship each separately.**

## Goal

`ship.ship { runtime: "rooms", room: { repos: [{ url }] }, … }` drives a cursor agent **inside a disposable rooms microVM**. The room is self-contained: clone → agent edits → **commit + push a branch** → report terminal state. The runner returns a `CursorRunResult` with the pushed branch in `branches[]`; **PR opening is downstream** (`/work-driver` / the operator via `gh pr create`), exactly as for a cloud run with `autoCreatePR: false` — ship's job ends at the agent-run terminal state. Net: **rooms is "our self-hosted cloud"** — same `CursorRunResult` contract as `CloudCursorRunner`, but the agent runs on our Firecracker host instead of Cursor's servers.

This is the capstone that makes rooms *used*: after this, `/work-driver` can fire `ship.ship { runtime: "rooms" }`, a real task lands a pushed branch via a microVM, and the driver opens the PR.

## The model: mirror cloud, not local

Decided in design discussion. The room must **persist its own work** (the whole point of an isolated room is a durable artifact, not loose files), so it pushes a branch — exactly like the cursor *cloud* agent does. Mirror-local (copy files back, host commits) was rejected: it couples every run to a host-side git environment and makes the room a glorified subprocess.

Consequences, all of which fall out of the existing cloud path:
- `RoomCursorRunner` returns a `CursorRunResult` with `branches[] = [{ repoUrl, branch }]` populated — the same field `CloudCursorRunner` fills from `result.git`.
- **PR opening is downstream, not the runner's job.** ship removed the `open_pr` component (PR creation moved out of the service — see `docs/features/ship-v2/spec.md`; codex flagged this on the design PR). So rooms matches what cloud already does with `autoCreatePR: false`: the runner reports `branches[0].branch`, and `/work-driver` (or the operator) opens the PR with `gh pr create` from that branch. **No new PR code in the runner, and no revival of `open_pr`** — rooms slots into the existing downstream-PR flow.
- The room only needs a **push-scoped token** (contents:write); `gh`/PR-scope creds stay host-side with the driver. Least privilege in the disposable VM.

## Functional

### Runtime + input
- Extend `CursorRunInput.runtime` to `"local" | "cloud" | "rooms"`. (The dossier task says `backend`, but the code keys everything off `runtime`; one more variant is the consistent move.)
- Add `room?: RoomRunSpec` parallel to `cloud?: CloudRunSpec`:
  ```ts
  interface RoomRunSpec {
    readonly repos: readonly [{ readonly url: string; readonly startingRef?: string }]; // single-repo, like cloud
    readonly image?: string;     // defaults to the host's agent-alpine-cursor.ext4
    readonly pushBranch?: string; // branch rooms pushes to. Default ALWAYS appends a uuid:
                                  // `rooms/<slug(agentName) || "run">-<short-uuid>` (workflowRunId is NOT on
                                  // CursorRunInput; agentName is conventionally `ship/<workflowRunId>`).
  }
  // No autoCreatePR for rooms v0 — the runner never opens a PR; downstream does
  // (see "The model"). Revisit if/when a room gains a PR-scope token + opens its own PR.
  ```

### `RoomCursorRunner` (`packages/cursor-runner/src/room-runner.ts`)
Implements `CursorRunner`. Unlike Local/Cloud it does **not** call `@cursor/sdk` in-process — it's a subprocess orchestrator over the `rooms` binary:
- `run(input)`: validate `runtime === "rooms"` + `room` present (else `WrongRunnerError` / a new `MissingRoomSpecError`). Spawn `sudo -E rooms run` — the Firecracker jailer needs root (rooms #44), and `-E` preserves the **subprocess env** so the jailed rooms keeps HOME + `GH_TOKEN` (+ `CURSOR_API_KEY`/`ANTHROPIC_API_KEY`); rooms reads them from its env and forwards push-only into the guest, so no token lands on argv:
  ```
  sudo -E rooms run --runner cursor \
    --image <room.image ?? default> --repo <room.repos[0].url> \
    --base-sha <room.repos[0].startingRef ?? "HEAD"> \
    --task <tmpfile(input.prompt)> --model <modelArgFromInput> \
    --push-branch <room.pushBranch ?? derived> --out <hostdir>
  ```
  (`--base-sha HEAD` is safe: rooms pins `refs/rooms/base` at clone, so a symbolic ref resolves to the concrete commit.) `<hostdir>` is a unique per-run temp dir ship creates (e.g. under `os.tmpdir()`); ship removes it after parsing on success, leaves it on error for debugging. rooms clears it at run start regardless.
- **IDs:** rooms has no SDK agent, so `run` returns synthetic `agentId = "room-<uuid>"` / `runId = "run-<uuid>"` on the `CursorRunHandle` (persisted to `cursor_runs.agent_id`/`run_id`; opaque — never round-tripped to an SDK, since `attach` is unsupported).
- **Terminal + events:** rooms writes the contract artifacts and `--out` collects them to `<hostdir>` before teardown. `RoomCursorRunner` reads the files directly; it first asserts `result.json.schema_version === 1` (rooms' `SCHEMA_VERSION`, `rooms/src/artifacts.rs` — pin that literal; bail with a clear error on drift), then replays `events.ndjson` through `input.onEvent` (each line is an `SDKMessage`), **then** resolves `handle.result`. Ordering guarantee: the `onEvent` replay completes before `result` resolves (local/cloud stream live; rooms replays terminally). Result: `CursorRunResult { status, summary (from summary.md), durationMs: ended_at − started_at (both on result.json), branches: [{ repoUrl: room.repos[0].url, branch: result.json.pushed_branch }] }`; `errorMessage` from `summary.md`/`result.json` when `status === "failed"`. (`rooms collect --from <hostdir>` is an available standalone validator; the runner reads + asserts directly rather than shelling it.)
- `attach`: throws `RoomResumeNotSupportedError` (no resume for v0 — rooms VMs are disposable; mirrors `LocalCursorRunner.attach`).
- No `downloadArtifact` (omitted, like local).

### Routing (`@ship/core`)
- `runtimeLabel(input)`: add the `"rooms"` case.
- The `input.runtime === "cloud"` routing branches (in `service.ts`): add a `"rooms"` arm calling the injected `roomCursor` runner; throw `RoomRunnerNotConfiguredError` if unconfigured (mirror `CloudRunnerNotConfiguredError`).
- `ShipServiceConfig.roomCursor?: CursorRunner` (optional, like `cloudCursor`), default `new RoomCursorRunner()`.
- **No `open_pr` change** (it was removed from ship): `branches[]` is persisted on the run row and surfaced via `get_workflow_run`; downstream (`/work-driver`/operator) reads `branches[0].branch` and opens the PR with `gh pr create`. Routing only needs to reach the rooms runner and persist its result — same as cloud-with-`autoCreatePR:false`.

### MCP surface (`packages/mcp`)
- `shipInputSchema`: `runtime` accepts `"rooms"`; add the `room` object; cross-field refinement — `workdir` optional for rooms (like cloud; rooms has no host worktree), `repo` derivable from `room.repos[0].url`.

### rooms-side (separate repo) — ✅ MERGED (rooms#39 + rooms#40), as built
- `rooms run --runner cursor --push-branch <b>`: on a **successful** agent run, the runner commits + pushes over the SSH connection rooms holds — `git checkout -B <b>`, `git add -A` *inside the disposable guest workspace* (a fresh clone in a throwaway VM, not a dev tree), commit with a `Co-authored-by: Cursor` trailer, push. "Nothing to push" is `HEAD == refs/rooms/base` (a ref pinned at clone — correct even when `--base-sha` is symbolic like `HEAD`). Auth: `GH_TOKEN` forwarded **only on the push SSH invocation** (never to the agent run / `--command`) via a git credential helper reading it from env — token never in argv; the tabled `secret-injection-via-vsock` task hardens the channel later.
- `result.json` gains `pushed_branch` (the pushed ref).
- `--out <hostdir>`: collects `/workspace/out` to the host before teardown via **tar-over-ssh, validating the archive before extraction** (rejects symlink/hardlink/device members and `..`/absolute paths so a guest-planted member can't escape `<hostdir>`; dir cleared each run). ship reads `events.ndjson`/`summary.md`/`result.json` directly from `<hostdir>`; `rooms collect --from <hostdir>` is a standalone validator, not invoked by the runner. This is the *only* artifact pull-back — no patch is pulled (the push carries the code).

## Tradeoffs
- **Mirror cloud vs mirror local** → cloud (room self-persists; reuses cloud's `branches[]` shape + the downstream-PR flow; no host git-env coupling).
- **rooms pushes vs ship pulls a patch** → rooms pushes (the room does the whole job; the code escapes via git, not a file).
- **Push-only token in room vs full `gh`** → push-only; the PR is opened downstream with the driver's `gh` (least privilege; no `gh` needed in the image).
- **Extend `runtime` vs new `backend` param** → extend `runtime` (consistent with all existing code).
- **One-shot `rooms run` vs compose `create`/`exec`/`destroy`** → one-shot for v0 (the primitive verbs don't exist in rooms yet; the push lives in the already-agent-specific cursor path, so the agnostic core stays clean). Primitive-verb composition is a later refactor.
- **Live event streaming vs terminal replay** → terminal replay for v0 (`onEvent` fired in stream order once `--out` lands; satisfies the fire-and-forget contract). Live tail is a fast-follow (rooms ED-5 deferred it too).

## EDs
- **ED-1: `RoomCursorRunner` is a subprocess orchestrator over the `rooms` binary**, not an `@cursor/sdk` caller. The SDK runs inside the VM (rooms' baked `cursor-runner.js`); ship parses rooms' contract artifacts.
- **ED-2: rooms-shaped result == cloud-shaped result.** `branches[0].branch` populated; the rest of ship treats a rooms run exactly like a cloud run with `autoCreatePR: false` — a terminal `CursorRunResult` + a pushed branch, PR opened downstream.
- **ED-3: the room commits + pushes (rooms-driven over SSH, not the LLM); the PR is opened downstream** (`/work-driver`/operator via `gh pr create`), since ship has no in-service PR opener. Push-only token in the room; PR-scope creds stay host-side with the driver.
- **ED-4: this feature spans both repos.** The rooms PRs (`--push-branch` rooms#39 + `--out` rooms#40) are **merged**; the ship side (PR-S1/S2) is the remaining work and now has its dependency satisfied.
- **ED-5: no attach/resume for rooms in v0** — VMs are disposable.

## Validation
- **L2 (fake):** a `FakeCursorRunner`-style rooms double; `ShipService.ship({ runtime: "rooms", room: { repos: [...] } })` routes to it, `cursor_runs.runtime === "rooms"` persists, the fake's `branches[0].branch` flows through `events.ndjson` and is readable via `get_workflow_run`. `RoomRunnerNotConfiguredError` when unconfigured.
- **L3 (real microVM, rooms-host, gated):** `ship.ship { runtime: "rooms", room: { repos: [{ url: <fixture> }], pushBranch: "rooms/<x>" } }` → microVM boots `agent-alpine-cursor.ext4` → agent edits → branch `rooms/<x>` pushed to the fixture remote → the run's `CursorRunResult.branches[0].branch === "rooms/<x>"` (readable via `get_workflow_run`) → the harness opens the PR from that branch via `gh pr create` and asserts it contains the change. Asserts the full self-hosted-cloud loop (room pushes; PR downstream).
- rooms-side (done): unit tests cover the `GH_TOKEN` push-only scoping and the `--out` tar member gate (symlink/`..`/absolute rejection); the L3 above exercises the live push + collect. The rooms-host e2e of `--out` itself is deferred (VM down post-reboot) — the L3 covers it end-to-end once the VM is up.

## Risks
- **Push token in the disposable VM.** Scoped to contents:write on the one repo; forwarded like the existing API keys for v0; vsock-hardened later. Smaller blast radius than a full `gh` cred.
- **Cross-repo coordination.** The rooms `--push-branch`/`--out` PRs are **merged**, so the ship side can proceed. Remaining sequence: PR-S1 (runner) → PR-S2 (routing) → L3 e2e (needs the rooms-host VM up).
- **rooms subprocess reliability / arg surface.** rooms is invoked as a CLI; a flag/contract drift breaks ship silently. Mitigation: pin the rooms invocation behind a small adapter + assert `result.json.schema_version` against the rooms runner contract on every run (see Functional), bailing with a clear error on mismatch.
- **Event fidelity.** Terminal replay (not live) for v0; a long run shows no progress until it finishes. Acceptable for v0; live tail is the fast-follow.

## Out-of-scope
- Live event streaming (fast-follow).
- rooms primitive verbs (`create`/`exec`/`collect`/`destroy`) — v0 uses one-shot `rooms run`.
- Attach/resume for rooms.
- Multi-repo rooms runs.
- rooms opening the PR itself — v0 always defers PR opening downstream (`/work-driver` / `gh pr create`); a room-opens-its-own-PR path (needs a PR-scope token in the VM) is a later option, not in `RoomRunSpec` for v0.

## Implementation-plan (PR boundaries)
1. **PR-R (rooms repo) — ✅ MERGED:** `--push-branch` (rooms#39, squash `5254829`) + `--out` (rooms#40, squash `973534b`). Commit+push over SSH (`-B`, in-guest `git add -A`, Cursor trailer, push-scoped `GH_TOKEN`, `refs/rooms/base` no-changes detection) + `--out` host collect (tar-over-ssh, validate-before-extract) + `result.json.pushed_branch`. rooms-side unit-tested; the rooms-host e2e is deferred (VM down) — PR-S's L3 exercises the live loop.
2. **PR-S1 (ship):** `RoomRunSpec` + `runtime: "rooms"` on `CursorRunInput`; `RoomCursorRunner` (run → spawn rooms → parse `--out` artifacts → `CursorRunResult`; attach throws; onEvent replay) + `FakeCursorRunner` rooms path + unit tests.
3. **PR-S2 (ship):** core routing (`runtime === "rooms"` → `roomCursor`, `RoomRunnerNotConfiguredError`; persist + surface `branches[]` — no `open_pr` revival) + MCP `shipInputSchema` (`runtime: "rooms"`, `room`, refinements) + the L2 routing test.
4. **e2e:** `ship.ship { runtime: "rooms" }` against a fixture on the rooms-host — the full loop.

Reviewers per repo: `@codex` + `@claude` (+ Copilot). This doc goes up as its own reviewed PR before any impl (ship design-phase convention).

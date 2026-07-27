# claude-in-rooms runner — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @michael (human:mh) / claude-code
**Date:** 2026-07-26
**Related:** `docs/features/rooms-backend/spec.md` (the rooms substrate + `RoomCursorRunner`), `docs/features/rooms-backend/phases/driver-rooms-dispatch.md` (#238 — the driver→N-rooms wiring this unlocks the agent for), itsHabib/rooms (the `rooms` CLI / Firecracker jailer).

> **Reviewers — focus areas:** §4 Decision 1 (rooms-side `--runner claude` backend vs ship-side orchestration) is the load-bearing call — it decides whether this is a cross-repo change. §4 Decision 2 (OAuth cred flow into the guest) is the security-sensitive one. §7 the push/no-changes flow. §9 the validation gate (the live 2-VM claude/rooms run) is what closes the portfolio hypothesis.

## 1. Problem & hypothesis

#238 shipped the driver → N-concurrent-rooms wiring, but it is **cursor-only**: `buildRoomsArgs` (`packages/cursor-runner/src/room-runner.ts`) hardcodes `--runner cursor`, which drives the baked `cursor-runner.js` inside the microVM against `CURSOR_API_KEY`. The operator has **no cloud cursor quota** and runs **claude-local via OAuth** everywhere. So the rooms end-to-end — the portfolio-hypothesis validation gate — cannot complete today: the substrate boots (proven: 2 concurrent Firecracker microVMs on the rooms-host, 2026-07-26), but no agent it can actually run.

**Hypothesis:** a rooms agent driven by **headless `claude -p`** (Claude Code print mode) using the operator's existing claude-local OAuth token closes the gate on the current setup — no cursor quota, no new subscription. This is how the *original* rooms POC ran (`claude -p` in the guest), so it's a return to a proven path, now wired through `ship driver`.

**Non-goals:**
- Not replacing the cursor runner — cursor-in-rooms stays for when quota exists. This *adds* claude as a legal rooms agent.
- Not Fable-in-rooms or a general multi-provider matrix — just claude, the agent the operator runs.
- Not fixing the rooms-host image-permission gap (§10) — that's an adjacent host-provisioning issue, tracked separately, though the e2e depends on it.
- Not cloud claude-in-rooms — rooms is self-hosted; the claude agent runs locally in the guest against the OAuth token.

## 2. Functional & non-functional requirements

**Functional:**
- `ship.ship { runtime: "rooms", provider: "claude", room: {…} }` drives a **claude** agent inside a microVM: clone → `claude -p` edits → commit + push a branch → report terminal state with `branches[0].branch`. Same `CursorRunResult`-shaped contract as the cursor path (rooms-backend ED-2).
- `ship driver` can fan out N concurrent `provider: "claude", runtime: "rooms"` streams (the #238 concurrency lane already handles the accounting; this makes claude/rooms a **legal, wired cell**).
- PR opening stays downstream (rooms-backend ED-3) — the runner reports the pushed branch; `/work-driver` / the operator opens the PR.

**Non-functional:**

| Concern | Target |
|---|---|
| Auth | OAuth token only (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`); **never** an API key in the guest (no credit on `.keys` anthropic key). Token is push-scoped-adjacent: it authorizes the model, `GH_TOKEN` authorizes the push (least privilege, same split as cursor). |
| Isolation | Token lives only in the disposable VM's env for the run's lifetime; VM is destroyed after (rooms ED-5, no resume). |
| Concurrency | N per-VM rootfs (no shared-image RW — see §8); bounded by the driver's `maxParallelRooms` (default 2). |
| Determinism | `claude -p` non-interactive, single-shot; the guest exit status + `result.json` drive the terminal state exactly as the cursor path. |
| Cost | $0 incremental beyond the operator's existing claude subscription (the whole point). |

## 3. Architecture overview

Reuse the entire rooms substrate; add one agent backend. The spine is unchanged from cursor:

```
ship driver (buildRoomShipInput, provider=claude)          ← #238, +legal-cell change
   → ship core selectRunner → RoomClaudeRunner              ← NEW (ship-side, thin)
       → sudo -E rooms run --runner claude --repo … --task … --push-branch …   ← NEW rooms backend
           → microVM: clone → claude -p → commit+push       ← NEW rooms-side (Rust)
       → parse result.json (branches[], patch)              ← reused (same contract as cursor)
```

**What's reused:** the Firecracker/jailer boot, `--out` tar collection, `--push-branch` git push over SSH, `result.json` contract, `buildRoomsEnv` cred carriage, the driver's concurrency lane + `buildRoomShipInput`.

**What's new:**
1. **rooms-side (itsHabib/rooms, Rust):** a `--runner claude` backend, a sibling of `--runner cursor` — clones `--repo`, runs `claude -p` against `--task`, commits + pushes `--push-branch`. Carries `CLAUDE_CODE_OAUTH_TOKEN` into the guest.
2. **ship-side:** `RoomClaudeRunner` (analog to `RoomCursorRunner`) that spawns `rooms run --runner claude …`; wired in `default-wiring`.
3. **ship-side legality:** make `(claude, rooms)` a legal wired cell — `dispatch-cell.ts` `LEGAL_RUNTIMES_BY_PROVIDER`, the rooms preflight (`collectRoomsPreflightErrors` currently rejects non-cursor via `isLegalCell`), and the MCP refinement (`refineClaudeProviderRuntime` currently says "claude supports only local or cloud").
4. **image:** a VM image with the Claude Code CLI installed (`agent-alpine-claude.ext4`, sibling of `agent-alpine-cursor.ext4`).

**The seam:** the runner backend (`--runner`). Everything above it (driver, core routing, result parsing) is agent-agnostic; everything below (clone/edit/push) is per-agent inside rooms.

## 4. Key decisions & trade-offs

### Decision 1 — rooms-side `--runner claude` backend (RECOMMENDED) vs ship-side orchestration around `--runner command`

`rooms run` today offers `--runner command` (runs an arbitrary command, **does not clone or push**) and `--runner cursor` (clones `--repo`, drives the agent, pushes `--push-branch`).

- **Option A (recommended): a rooms-side `--runner claude` backend.** Mirrors cursor exactly — clone + push stay *inside* rooms, so ED-3 (the room commits + pushes; PR opened downstream) holds unchanged, and the ship-side `RoomClaudeRunner` stays a thin subprocess orchestrator. Cost: a Rust change in itsHabib/rooms + a new image; cross-repo coordination (same shape as the merged rooms `--push-branch`/`--out` PRs).
- **Option B: ship orchestrates around `--runner command`.** ship would run `rooms run --runner command --command 'git clone … && claude -p … && git push …'`. Keeps everything in ship, no rooms change — but it **leaks git clone/push into ship**, duplicating what rooms already does for cursor, and puts the push-scoped `GH_TOKEN` handling in a shell string. This violates the rooms design's clean split (agent execution + git lives in rooms; ship parses artifacts). Rejected as the default.

**Recommendation: Option A.** The symmetry with cursor is the whole value — one seam (`--runner`), swappable backends, ship stays dumb. Option B is the fast hack if the rooms-side change is blocked; note it as the fallback.

### Decision 2 — OAuth token carriage into the guest

The operator authenticates claude-local via **OAuth** (subscription), not an API key. Precedence matters: a bogus `ANTHROPIC_API_KEY` hard-fails the CLI (see `reference_claude_cli_env_key_precedence`), and the `.keys` anthropic key has no credit. So:

- Carry **only** `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_AUTH_TOKEN`) into the guest via `buildRoomsEnv` → `sudo -E` → guest env; **never** set `ANTHROPIC_API_KEY` in the guest.
- Source from `~/.config/rooms/secrets.env` on the host (where `GH_TOKEN` already lives for cursor).
- The token is the model credential; `GH_TOKEN` (push-scoped) is the git credential — same least-privilege split cursor uses.
- **Trade-off:** the OAuth token is a subscription credential in a disposable VM. Acceptable given rooms VMs are single-use and destroyed post-run; the token never persists to an image. Flag for the adversarial reviewer: confirm the token can't leak into `result.json` / the `--out` tar / the pushed commit.

### Decision 3 — image strategy

`claude -p` needs the Claude Code CLI + Node in the guest. Build `agent-alpine-claude.ext4` (sibling of the cursor image). Decision: bake the CLI into the image (fast boot, no per-run install) vs install-on-boot (slower, always-latest). **Recommend baked** — matches the cursor image pattern; version bumps are an image rebuild, tracked like the cursor image.

## 5. Data model

No new persistent entities. Reused/extended:
- `cursor_runs.runtime = "rooms"` + `provider = "claude"` (both columns already exist; this is the first `(rooms, claude)` combination to become legal).
- `ShipInput.room` — unchanged shape (`repos`, `image`, `pushBranch`); `image` now may point at the claude image, `provider: "claude"` selects the backend.
- `RoomRunSpec` (cursor-runner) — unchanged; the runner selection keys off `provider`, not a new room field.
- The `LEGAL_RUNTIMES_BY_PROVIDER` matrix gains `rooms` under `claude`: `claude: ["local", "cloud", "rooms"]`.

## 6. API contract

**ship-side (`@ship/core` + `@ship/cursor-runner`):**
- `RoomClaudeRunner implements AgentRunner` — `run(input): AgentRunHandle`, same interface as `RoomCursorRunner`. `buildRoomsArgs` variant emits `--runner claude` + `--model` (a claude model id) instead of `--runner cursor`.
- `selectRunner`: `(runtime === "rooms" && provider === "claude") → config.roomClaude`; throw `RoomClaudeRunnerNotConfiguredError` when unset (mirrors `RoomRunnerNotConfiguredError`).
- `ShipServiceConfig.roomClaude?: AgentRunner`; default wiring constructs `new RoomClaudeRunner({ defaultImage: SHIP_ROOMS_CLAUDE_IMAGE })`.
- Legality: `isLegalCell("claude", "rooms") → true`; `collectRoomsPreflightErrors` allows `claude`; `refineClaudeProviderRuntime` allows `rooms`.

**rooms-side (itsHabib/rooms):**
- `rooms run --runner claude --repo <url> --task <path> --model <id> --base-sha <sha> --push-branch <branch> [--image …] [--out …]` — clone, run `claude -p "$(cat task)"` in `/workspace/repo`, commit (Claude Code trailer), push `--push-branch` via `GH_TOKEN`, write `result.json` with `pushed_branch` + `patch`.
- Requires `CLAUDE_CODE_OAUTH_TOKEN` in the env (parallel to cursor's `CURSOR_API_KEY`), enforced with a clear pre-boot error.

**Error model:** same categories as cursor (`sdk-throw`, dispatch failure, push failure). A missing/invalid OAuth token → a clear `claude auth` failure surfaced as the run's `failureCategory`, not an opaque hang.

## 7. Key flows

**Happy path (single stream):**
1. `ship driver` dispatches a `provider: "claude", runtime: "rooms"` stream → `buildRoomShipInput` emits `{ runtime: "rooms", provider: "claude", branch, room: { repos:[{url,startingRef}], pushBranch } }`.
2. core `selectRunner` → `RoomClaudeRunner` → `sudo -E rooms run --runner claude …` with `CLAUDE_CODE_OAUTH_TOKEN` + `GH_TOKEN` on the env.
3. Guest: clone `--repo` at `--base-sha` → `claude -p <task>` edits files → `git commit` (Claude trailer) → `git push` `--push-branch`.
4. rooms writes `result.json` (`pushed_branch`, `patch`); host collects via `--out`; ship parses → `branches[0].branch` surfaces via `get_workflow_run`.
5. Driver lands the stream (adopts the pushed branch); PR opened downstream.

**No-changes path:** `claude -p` makes no edits → no commit → rooms reports no `pushed_branch` (the `refs/rooms/base` no-changes detection already built for cursor) → driver marks the stream done-without-PR, same as cursor.

**Push-failure path:** commit succeeds, push fails (token scope / network) → `result.json` records the agent success but the push error surfaces → run `failed` with the push error (reuses the cursor exit-fold logic).

**Concurrency (N streams):** driver dispatches ≤ `maxParallelRooms` claude/rooms streams; each gets its own microVM with its **own** rootfs copy (§8); N `claude -p` runs proceed independently; the driver polls all N to terminal.

## 8. Concurrency / consistency / failure model

- **Per-VM rootfs is mandatory.** A single image opened read-write by N concurrent VMs corrupts (confirmed reasoning from the live session — the jailed firecracker opens the rootfs RW). rooms must give each run its own writable rootfs (copy-on-boot or read-only base + per-VM overlay). **Open question (§10):** does the current rooms jailer already copy per-run, or is per-VM isolation an unmet requirement? The live 2-VM proof used two *separate* image files by hand — the automated path must not share.
- **Token isolation:** each VM's env carries the OAuth token only for its lifetime; no cross-VM sharing beyond the identical token value; VMs are destroyed post-run.
- **Failure independence:** one stream's VM failure (auth, push, agent error) fails only that stream; the driver's existing per-stream failure handling (`decide`) applies unchanged.
- **Degraded mode:** OAuth token absent/expired → every claude/rooms dispatch fails fast pre-boot with a clear auth error, not a burned VM.

## 9. Rollout / implementation plan

| Phase | Goal | High-level tasks | Depends-on | Gate |
|---|---|---|---|---|
| **P1 — claude image** | A bootable VM image with Claude Code CLI + Node | build `agent-alpine-claude.ext4`; verify `claude -p "echo"` runs in the guest with an OAuth token via `rooms run --runner command` | rooms substrate (host image-perms fix, §10) | — |
| **P2 — rooms `--runner claude`** (itsHabib/rooms, Rust) | rooms clones + runs `claude -p` + pushes | `--runner claude` backend mirroring cursor; OAuth-token guard; `result.json.pushed_branch`; unit tests with the rooms-CLI double | P1 | — |
| **P3 — ship RoomClaudeRunner + legal cell** | ship dispatches claude/rooms | `RoomClaudeRunner` + `buildRoomsArgs` claude variant; `selectRunner` + `roomClaude` wiring; `isLegalCell`/preflight/MCP-refinement make `(claude,rooms)` legal; unit tests (routing + legality) | P2 | — |
| **P4 — live e2e** ⛳ **VALIDATION GATE** | prove it end-to-end | `ship driver` with a 2-stream `provider:claude, runtime:rooms` manifest against a throwaway fixture repo on the rooms-host → 2 concurrent claude-in-rooms VMs each clone→edit→push a branch | P3 | **the portfolio-hypothesis gate** |

Rough scope: P1 ~image work (0× LOC, ops); P2 ~250 weighted (rooms Rust + tests); P3 ~200 weighted (ship TS + tests, amazing/ideal band); P4 is a run, not a PR. Everything before P4 is committed; P4 *is* the gate.

## 10. Open questions

1. **Per-VM rootfs isolation** — does the current `rooms` jailer copy the rootfs per run (safe for concurrency) or use it in place (unsafe)? If unsafe, that's a rooms-side prerequisite folded into P2. (Blocks concurrent claude/rooms; the live 2-VM proof sidestepped it with separate files.)
2. **Host image-permission gap** — `~/rooms/images/*.ext4` are `root:root 644`; the jailed firecracker needs a writable rootfs, so stock boots fail (`Permission denied manipulating backing file`). This is an adjacent host-provisioning fix (chown/perms or rooms per-VM-copy) that P1/P4 depend on but that isn't strictly *this* feature. File separately?
3. **`claude -p` inside a minimal alpine guest** — does the Claude Code CLI run headless with only an OAuth token and no interactive login state? Needs a P1 spike. (The original POC did this — confirm it still holds on current CLI.)
4. **Model selection** — what claude model id does the guest `claude -p` use, and does it honor `--model`? Tie to the driver's tier mapping.

## 11. Validation plan

**The gate (P4):** on the rooms-host, `ship driver` imports a 2-stream manifest (`provider: claude, runtime: rooms`, two branches, a throwaway fixture repo URL), runs with `maxParallel.rooms: 2`, and:

- **binary signal:** two Firecracker microVMs boot concurrently, each runs `claude -p`, each pushes its own branch, and the driver drives both streams to a terminal `landed`/done state with `branches[0].branch` populated — **no cursor quota consumed**.
- Baseline-free: either two branches land from two concurrent claude-driven VMs, or they don't. That flips the portfolio hypothesis (self-hosted N-agent fan-out on the operator's own subscription) go/no-go.

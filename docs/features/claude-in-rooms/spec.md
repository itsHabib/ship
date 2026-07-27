# claude-in-rooms runner — Technical Design Document

**Status:** draft / proposal (v2) — NOT a build commitment. The artifact we decide from.
**Owner:** @michael (human:mh) / claude-code
**Date:** 2026-07-26 (v2: 2026-07-27, design-review fold-in)
**Related:** `docs/features/rooms-backend/spec.md` (the rooms substrate + `RoomCursorRunner`), `docs/features/rooms-backend/phases/driver-rooms-dispatch.md` (#238 — the driver→N-rooms wiring this unlocks the agent for), itsHabib/rooms (the `rooms` CLI / Firecracker jailer).

> **Reviewers — focus areas:** §4 Decision 1 (rooms-side `--runner claude` backend vs ship-side orchestration) is the load-bearing call — it decides whether this is a cross-repo change. §4 Decision 2 (OAuth cred flow into the guest) is the security-sensitive one. §7 the push/no-changes flow. §9 the validation gate (the live 2-VM claude/rooms run) is what closes the portfolio hypothesis.

> **v2 changelog (design-review fold-in, codex + claude[bot]):** all three §4 decisions confirmed by both reviewers. Hardened the OAuth leak-prevention story — the one gap both reviewers converged on: §4 Decision 2 now routes rooms creds through the existing `resolveDispatchCredential` policy gate + requires an allowlisted guest env + treats the bearer-in-subprocess threat explicitly. Promoted the credential-leak checks and the guest→`api.anthropic.com` egress question from soft "flags" to firm P1 requirements. Added the no-branch-success state-machine transition (§7/§8), the auth-failure-pre-boot named flow (§7), named the two per-VM-rootfs approaches (§8/§10.1), and made the open-question→phase blocking order explicit (§9). cursor hit its usage limit; Copilot did not fire.

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
| Auth | OAuth token only (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`); `ANTHROPIC_API_KEY` **explicitly stripped and asserted-absent** in the guest env, not merely omitted (no credit on `.keys` anthropic key; `sudo -E` forwards the whole host env). Routed through the `resolveDispatchCredential` policy chokepoint (§4a). Token authorizes the model, `GH_TOKEN` (push-scoped) authorizes the push (least privilege, same split as cursor). |
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

**What's reused:** the Firecracker/jailer boot, `--out` tar collection, `--push-branch` git push over SSH, `result.json` contract, the `buildRoomsEnv` cred-carriage *mechanism* (the claude path adds an allowlist + `ANTHROPIC_API_KEY` assertion on top — §4a), the driver's concurrency lane + `buildRoomShipInput`.

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

**Approach is confirmed by both design reviewers, but the leak-prevention story was the one gap both flagged. v2 makes it a hard part of the design, not a trade-off note:**

**(a) Route rooms creds through the existing policy gate — a legal-cell change is *not* sufficient.** Both reviewers observed that flipping `LEGAL_RUNTIMES_BY_PROVIDER` alone leaves three holes:
- `missingClaudeEnv` / `checkClaudeCredential` today accept `ANTHROPIC_API_KEY` for *every* non-cloud claude runtime. rooms must demand **rooms-specific OAuth viability** — an API-key-only dispatch must fail preflight, not silently forward a no-credit (and CLI-hard-failing) key.
- Placing `RoomClaudeRunner` in `@ship/cursor-runner` would bypass the `resolveDispatchCredential` chokepoint that both existing claude runners use for `.ship.json` token pinning and `forbid_env`. The claude/rooms path **must go through the same credential-policy chokepoint** — do not route around it by package placement.
- **`buildRoomsEnv` must build an explicit allowlist, not copy `process.env`.** It carries all of the host env today; `sudo -E` forwards the whole calling environment, so an operator dotfile that sets `ANTHROPIC_API_KEY` would reach the guest. The claude path must construct an allowlisted guest env **and assert `ANTHROPIC_API_KEY` is absent** (strip explicitly + assert, not merely omit).

**(b) Protect the bearer from agent subprocesses (threat, not just a leak-check).** codex's sharpest point: post-run VM disposal does *not* prevent theft during the run. An OAuth bearer in the `claude -p` process env is reachable by same-user tool subprocesses (env inheritance or `/proc`) — a prompt-injected or malicious task could write it into the collected `--out` artifacts / a pushed commit, or exfiltrate it over the model's allowed egress **before** teardown. The carriage decision must not rest on post-run destruction alone. Two acceptable resolutions, to pick during P1/P2:
  1. **Constrain to trusted inputs** — explicitly scope claude/rooms to operator-authored tasks against operator-owned repos and *record that trust assumption* in the doc + the runner. Cheapest; matches today's actual usage (the operator's own driver tasks).
  2. **Credential-broker boundary** — keep the bearer out of the agent-executed process (broker/proxy holds it, guest gets a scoped short-lived artifact). Correct long-term; larger scope. (Ties to `project_keyproxy_broker_research` — the unified local broker seam.)

  v2 recommendation: ship P4 under resolution **1** (trusted-inputs, recorded) and note the broker as the hardening path when claude/rooms ever runs untrusted input.

**(c) Leak-verification is a firm P1 exit criterion, not a soft flag.** The P1 spike (§10) must confirm, after a real guest run:
- `grep -r CLAUDE_CODE_OAUTH_TOKEN /workspace` returns empty (nothing the `--out` tar or a commit could pick up).
- `claude -p` print mode writes no auth/session cache under `/workspace/**` (the tar + push boundary).
- the token does not appear in `result.json`.

**Known limitation (record, don't solve):** OAuth token mid-run expiry. A claude/rooms run exceeding the token lifetime (>~1h) fails mid-run with an auth error; surfaced as a `failed` stream with an auth `failureCategory` (see §7 degraded flow). Acceptable for the gate; not refreshed in v1.

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
- `rooms run --runner claude --repo <url> --task <path> --model <id> --base-sha <sha> --push-branch <branch> [--image …] [--out …]` — clone, run `claude -p "$(cat task)"` in `/workspace/repo`, commit (Claude Code trailer — see below), push `--push-branch` via `GH_TOKEN`, write `result.json` with `pushed_branch` + `patch`.
- Requires `CLAUDE_CODE_OAUTH_TOKEN` in the env (parallel to cursor's `CURSOR_API_KEY`), enforced with a clear pre-boot error.
- **`--task` path semantics:** the cursor path's convention governs — the runner backend copies the host-provided task file into the guest rootfs before `claude -p` reads it (it is not assumed to already exist in the guest). §6 rooms-CLI contract must state this explicitly so the claude backend copies identically.
- **Commit trailer ownership:** the rooms `--runner claude` backend adds the `Co-Authored-By: Claude <model-name> <noreply@anthropic.com>` trailer (CLAUDE.md "Agent commit trailers"). `claude -p` print mode does not commit, so the backend owns the commit + trailer and fills `<model-name>` from `--model`.

**Error model:** same categories as cursor (`sdk-throw`, dispatch failure, push failure). Mapping for the claude backend:
- cursor's `sdk-throw` (an SDK exception) has no direct analog — the `claude -p` equivalent is a **non-zero exit + stderr**. The backend must map a non-zero `claude -p` exit to a `sdk-throw`-equivalent `failureCategory` and surface stderr in `result.json`, not an opaque hang.
- A missing/invalid OAuth token (absent, or expired mid-run) → a clear `claude auth` failure surfaced as the run's `failureCategory`.

## 7. Key flows

**Happy path (single stream):**
1. `ship driver` dispatches a `provider: "claude", runtime: "rooms"` stream → `buildRoomShipInput` emits `{ runtime: "rooms", provider: "claude", branch, room: { repos:[{url,startingRef}], pushBranch } }`.
2. core `selectRunner` → `RoomClaudeRunner` → `sudo -E rooms run --runner claude …` with `CLAUDE_CODE_OAUTH_TOKEN` + `GH_TOKEN` on the env.
3. Guest: clone `--repo` at `--base-sha` → `claude -p <task>` edits files → `git commit` (Claude trailer) → `git push` `--push-branch`.
4. rooms writes `result.json` (`pushed_branch`, `patch`); host collects via `--out`; ship parses → `branches[0].branch` surfaces via `get_workflow_run`.
5. Driver lands the stream (adopts the pushed branch); PR opened downstream.

**No-changes path (⚠ requires a state-machine fix — codex P1):** `claude -p` makes no edits → no commit → rooms reports no `pushed_branch` (the `refs/rooms/base` no-changes detection already built for cursor). The driver does **not** correctly handle this today: `handleSucceededPoll` unconditionally applies `buildLandedPatch`, and `isBlockedOnMerges` treats every `landed` stream as awaiting a merge — so a no-branch success would stick in `blocked_on_merges` and could stall dependent batches instead of resolving. **P3 must add an explicit success-without-branch → `done` transition** (a `landed` stream whose `result.json` has no `pushed_branch` is done-without-PR, not merge-pending) **with tests**, before this flow is relied on. This is a real driver change, not just a claude-runner concern — it was latent on the cursor path too but the claude/rooms gate is the first place it's exercised.

**Push-failure path:** commit succeeds, push fails (token scope / network) → `result.json` records the agent success but the push error surfaces → run `failed` with the push error (reuses the cursor exit-fold logic).

**Auth-failure-pre-boot path:** OAuth token absent / expired / not propagated into the guest → rooms pre-boot credential check fails → the stream fails fast with an `auth-missing` category **before a VM is allocated** (no burned VM). This is the fail-fast case §8 names; it is a distinct named flow because it terminates the stream at a different point (pre-dispatch, not post-run). Mid-run token expiry (>~1h run) is the degraded variant: the VM boots, `claude -p` fails partway with an auth error → `failed` with an auth `failureCategory` (the §4 known limitation).

**Concurrency (N streams):** driver dispatches ≤ `maxParallelRooms` claude/rooms streams; each gets its own microVM with its **own** rootfs copy (§8); N `claude -p` runs proceed independently; the driver polls all N to terminal.

## 8. Concurrency / consistency / failure model

- **Per-VM rootfs is mandatory.** A single image opened read-write by N concurrent VMs corrupts (confirmed reasoning from the live session — the jailed firecracker opens the rootfs RW). rooms must give each run its own writable rootfs. Two approaches, named so the rooms maintainer can pick:
  1. **Full copy per run** — `cp` the base image to a per-VM writable copy before boot. Simple; matches exactly what the live 2-VM proof did by hand. Costs N× the image size in disk (a ~500 MB image → ~1 GB at N=2). Manageable at the driver's default `maxParallelRooms: 2`.
  2. **Read-only base + per-VM overlay** — CoW: one shared RO base, a per-VM writable overlay. Less disk, faster if image setup is slow. Requires rooms-side overlay support.
  **This is the highest-risk open question (§10.1)** and it drives P2 scope: the automated path must never share a RW rootfs. The live 2-VM proof sidestepped it with two *separate* files by hand — the code path cannot.
- **No-branch success is a terminal state, not merge-pending.** A stream whose VM succeeds but produces no pushed branch resolves to `done` (done-without-PR), not `blocked_on_merges` — see the §7 no-changes path and the P3 driver fix it requires.
- **Token isolation:** each VM's env carries the OAuth token only for its lifetime; no cross-VM sharing beyond the identical token value; VMs are destroyed post-run.
- **Failure independence:** one stream's VM failure (auth, push, agent error) fails only that stream; the driver's existing per-stream failure handling (`decide`) applies unchanged.
- **Degraded mode:** OAuth token absent/expired → every claude/rooms dispatch fails fast pre-boot with a clear auth error, not a burned VM.

## 9. Rollout / implementation plan

| Phase | Goal | High-level tasks | Depends-on | Gate |
|---|---|---|---|---|
| **P1 — claude image + spike** | A bootable VM image with Claude Code CLI + Node, proven headless | build `agent-alpine-claude.ext4`; verify `claude -p "echo"` runs headless in the guest with only an OAuth token via `rooms run --runner command`; **leak-verification exit criteria (§4c)**: `grep -r CLAUDE_CODE_OAUTH_TOKEN /workspace` empty, no auth cache under `/workspace/**`, token absent from `result.json`; **confirm guest→`api.anthropic.com` egress is permitted** by the rooms Firecracker net config | **§10.2 host image-perms fix + §10.3 egress must be resolved first** | — |
| **P2 — rooms `--runner claude`** (itsHabib/rooms, Rust) | rooms clones + runs `claude -p` + pushes | `--runner claude` backend mirroring cursor; OAuth-token guard; allowlisted guest env (no `ANTHROPIC_API_KEY`, asserted); per-VM rootfs handling (§10.1 approach); commit-trailer + `--task` copy; non-zero-exit → `sdk-throw`-equiv mapping; `result.json.pushed_branch`; unit tests with the rooms-CLI double | P1 + **§10.1 per-VM-rootfs answer (may expand scope)** | — |
| **P3 — ship RoomClaudeRunner + legal cell + driver fix** | ship dispatches claude/rooms | `RoomClaudeRunner` + `buildRoomsArgs` claude variant routed through the `resolveDispatchCredential` chokepoint (§4a — not around it by package placement); rooms-specific OAuth viability in preflight; `selectRunner` + `roomClaude` wiring; `isLegalCell`/preflight/MCP-refinement make `(claude,rooms)` legal; **no-branch-success → `done` driver transition + tests (§7)**; unit tests (routing + legality) | P2 (impl); may build + review against a rooms-CLI mock **concurrently with P2** once §6's `rooms run --runner claude` interface is frozen | — |
| **P4 — live e2e** ⛳ **VALIDATION GATE** | prove it end-to-end | `ship driver` with a 2-stream `provider:claude, runtime:rooms` manifest against a throwaway fixture repo on the rooms-host → 2 concurrent claude-in-rooms VMs each clone→edit→push a branch | P3 | **the portfolio-hypothesis gate** |

**Open-question → phase blocking order (v2 — made explicit):** §10.2 (host image perms) + §10.3 (guest egress to `api.anthropic.com`) block **P1** — neither an image test nor the spike can run without them. §10.1 (per-VM rootfs isolation) blocks **P2** — it needs a rooms-maintainer answer before Rust work starts, since it may expand P2 scope. §10.4 (model selection) can defer to P3/P4.

**P2/P3 concurrency:** once the §6 `rooms run --runner claude` CLI interface is frozen (before the Rust impl lands), P3's `RoomClaudeRunner` + `selectRunner` can be built, tested, and reviewed against a rooms-CLI mock in parallel with P2 — saving wall-clock if both move together. P3's *live* behavior still depends on P2.

Rough scope: P1 ~image work + spike (0× LOC, ops); P2 ~250 weighted (rooms Rust + tests); P3 ~200–250 weighted (ship TS + tests incl. the driver no-branch transition, amazing/ideal band); P4 is a run, not a PR. Everything before P4 is committed; P4 *is* the gate.

## 10. Open questions

1. **Per-VM rootfs isolation (highest-risk; blocks P2).** Does the current `rooms` jailer copy the rootfs per run (safe for concurrency) or use it in place (unsafe)? **Explicit question for the rooms maintainer:** does the jailer already copy the rootfs per run, and if not, which approach do we take — **full copy per run** or **read-only base + per-VM overlay** (§8)? The answer sets P2 scope. (Blocks concurrent claude/rooms; the live 2-VM proof sidestepped it with separate files by hand — the code path cannot.)
2. **Host image-permission gap (blocks P1).** `~/rooms/images/*.ext4` are `root:root 644`; the jailed firecracker needs a writable rootfs, so stock boots fail (`Permission denied manipulating backing file`; a writable copy boots clean). Adjacent host-provisioning fix (chown/perms or rooms per-VM-copy). Track separately, but P1 cannot produce a testable artifact until it's resolved.
3. **`claude -p` headless in a minimal alpine guest — this IS the P1 spike.** Does the Claude Code CLI run headless with only an OAuth token and no interactive login state? (The original POC did this — confirm on current CLI.) The spike also owns the §4c leak-verification exit criteria.
4. **Guest egress to `api.anthropic.com` (blocks P1; verify in the spike).** `claude -p` must reach `api.anthropic.com` from inside the microVM to make model calls. If the rooms Firecracker network config restricts egress (e.g. only GitHub for `git push`), the claude agent can't run at all — potential hard blocker. Confirm allowed egress as part of the P1 spike.
5. **Model selection (defer to P3/P4).** What claude model id does the guest `claude -p` use, and does it honor `--model`? Tie to the driver's tier mapping; `claude-sonnet-4-5` is a safe default for the gate run.

## 11. Validation plan

**The gate (P4):** on the rooms-host, `ship driver` imports a 2-stream manifest (`provider: claude, runtime: rooms`, two branches, a throwaway fixture repo URL), runs with `maxParallel.rooms: 2`, and:

- **binary signal:** two Firecracker microVMs boot concurrently, each runs `claude -p`, each pushes its own branch, and the driver drives both streams to a terminal `landed`/done state with `branches[0].branch` populated — **no cursor quota consumed**.
- Baseline-free: either two branches land from two concurrent claude-driven VMs, or they don't. That flips the portfolio hypothesis (self-hosted N-agent fan-out on the operator's own subscription) go/no-go.

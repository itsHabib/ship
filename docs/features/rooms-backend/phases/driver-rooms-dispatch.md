# Phase: driver → N concurrent rooms dispatch

**Status**: in progress
**Owner**: claude-code (Opus 4.8)
**Date**: 2026-07-25
**Spec**: [`../spec.md`](../spec.md) — the contract. This is the driver-side wiring for Implementation-plan step 4 ("e2e: `ship.ship { runtime: "rooms" }` … the full loop"). Stacks on PR-S1 (`RoomCursorRunner`) + PR-S2 (rooms routing + MCP surface), both merged: `ship.ship { runtime: "rooms" }` already reaches the runner. This phase teaches the **driver engine** to build that input and drive N of them concurrently through its existing dispatch→poll→judgment→land loop.

## Scope

| Bucket | Files | Weighted |
|---|---|---|
| source (1×) | `packages/driver/src/engine.ts` (`buildRoomShipInput` + `buildShipInput` rooms branch, rooms preflight, rooms concurrency lane: `InFlightByRuntime` + `canDispatchStream` + `bumpInFlightAfterDispatch` + `countInFlight` widen + `maxParallelRooms`), `packages/driver/src/types.ts` (`RunOpts.maxParallel.rooms`), `packages/core/src/default-wiring.ts` (`SHIP_ROOMS_IMAGE` → runner `defaultImage`) | ~155 |
| tests (0.5×) | `engine.test.ts` (rooms dispatch input, rooms cap, rooms preflight, rooms park) | ~80 |
| docs (0×) | this doc | 0 |

**~190 weighted — amazing band.**

## Problem

Today the composition "`/work-driver` fans N tasks into N concurrent rooms microVMs" is a deliberate hard-stop. `ship.ship { runtime: "rooms" }` works (PR-S1/S2), but the **driver engine refuses rooms streams**: `collectStreamPreflightErrors` throws `PreconditionError("rooms stream … is not supported by the engine yet — dispatch rooms work via ship.ship directly")`, and `buildShipInput` repeats the refusal. A rooms stream also slips the parallel cap entirely — `canDispatchStream` only counts `local` and `cloud`, so N rooms streams would all dispatch in one tick with no ceiling. This phase removes the refusal and adds the rooms lane so the driver can fan out and bound rooms exactly like it does cloud.

## Functional

### Build a rooms `ShipInput` (`buildRoomShipInput`)

New builder alongside `buildCloudShipInput` / `buildLocalShipInput`. Rooms is modeled as **"our self-hosted cloud"** (spec ED-2), so the builder mirrors the cloud builder:

- Requires `ctx.repoUrl` (rooms clones from a URL, like cloud) — `PreconditionError` when absent, matching the cloud message shape.
- Requires `stream.branch` (rooms **pushes** a branch; the driver opens the PR from it downstream) — `PreconditionError` when absent, matching the local message shape. This is the `room.pushBranch`, so the driver names the branch deterministically instead of letting the runner derive one (which would defeat downstream PR-open-by-branch).
- `startingRef` from the stream's manifest `base_branch` (via `extractStreamBaseBranch`), same resolution as cloud, threaded into `room.repos[0].startingRef`.
- Emits `{ branch, docPath, repo, runtime: "rooms", workdir: ctx.repoRoot, room: { repos: [{ url, startingRef? }], pushBranch } }`. `workdir` carries the local repo root as the policy-resolution cwd (the credential guard + dispatch-policy ceiling resolve `.ship.json` from this checkout), exactly as the cloud builder documents.
- **The branch is set twice, on purpose.** `room.pushBranch` tells the runner which branch to push inside the VM; the top-level `branch` is what core persists as the run's `worktree.branch`. The recovery filter (`filterRecoveryCandidates`) already special-cases rooms alongside local — it matches a live rooms workflow on `worktree.branch === stream.branch`. Unlike cloud (cursor picks the branch, so recovery can't match on it), rooms knows its branch up front. Omitting the top-level `branch` persists it as `"(unknown)"`, so a post-dispatch store-write failure would make recovery reject the live VM and dispatch a **duplicate** microVM against the same push branch.

### Supply the rooms image (`default-wiring.ts`)

The `rooms` CLI requires `--image` and `RoomCursorRunner` has no built-in default, so a rooms dispatch fails synchronously (`MissingRoomImageError`) unless an image is supplied. The image is a property of the KVM host, not the task, so the composition root reads `SHIP_ROOMS_IMAGE` and passes it as the runner's `defaultImage` (`new RoomCursorRunner({ defaultImage: process.env["SHIP_ROOMS_IMAGE"] })`). A per-run `room.image` still overrides it; an injected `roomCursor` (tests) is untouched. The runner stays a pure mechanism configured by its opts.

`buildShipInput` replaces its rooms `throw` with a third branch: `runtime === "rooms" ? buildRoomShipInput(…) : …`. `provider` + tier mapping flow downstream unchanged (`applyTierMapping`), so a rooms stream picks its cursor model the same way local/cloud do.

### Rooms concurrency lane — the real "N rooms at once" logic

The in-flight accounting threads two scalars (`local`, `cloud`) through the dispatch loop. This phase folds them into one `InFlightByRuntime { local; cloud; rooms }` record threaded through `dispatchBatchStreams` → `canDispatchStream` → `bumpInFlightAfterDispatch`, and returns the full record from `dispatchBatchStreams` (dropping the between-batch cloud recompute, which the threaded record makes redundant — the local/cloud asymmetry goes away as a side benefit).

- `ResolvedRunOpts.maxParallelRooms` + `RunOpts.maxParallel.rooms`; default `DEFAULT_MAX_PARALLEL_ROOMS = 2` (conservative — a microVM is heavier than a cloud dispatch; the operator raises it explicitly once the host proves out).
- `canDispatchStream`: `runtime === "rooms" && inFlight.rooms >= opts.maxParallelRooms → false`.
- `bumpInFlightAfterDispatch`: `runtime === "rooms" → rooms + 1`.
- `countInFlight` runtime param widened to `"local" | "cloud" | "rooms"` (the body already filters `s.runtime === runtime` — no logic change).

### Pre-flight

- `collectStreamPreflightErrors`: replace the rooms `throw` with the same repo_url + branch checks the builder enforces (fail closed at import-adjacent preflight, not deep in dispatch).
- **Reject non-cursor rooms cells.** Rooms is cursor-only, but import's provider validation only special-cases codex-non-local + claude-cloud — a claude/rooms or codex/rooms cell (including via `default_provider`) passes import. The rooms preflight rejects it via the `isLegalCell` matrix (an `"unwired-cell"`) before dispatch, instead of letting core's `selectRunner` fail it mid-flight with an opaque `IllegalProviderRuntimeError`.

## Tradeoffs / decisions

- **Rooms == cloud for accounting and input shape** (spec ED-2). Reuses `extractStreamBaseBranch` / `ctx.repoUrl` / the `workdir`-carries-repo-root convention rather than inventing a rooms-specific path. Keeps the builder a peer, not a special case.
- **`pushBranch` is required, not derived.** The runner will `derivePushBranch(agentName)` if absent, but the driver must know the branch to open the PR downstream (spec ED-3: PR opening is downstream via `gh pr create`). Requiring `branch` on rooms streams mirrors local and makes the branch deterministic.
- **Fold two scalars into a record instead of adding a third scalar.** Three positional `number` params through four functions is the wrong shape; one `InFlightByRuntime` record is the sharp API and removes the pre-existing local-threaded/cloud-recomputed asymmetry.
- **Default cap 2, not 4.** A Firecracker microVM is heavier than a cloud dispatch; start conservative, let the operator raise it.

## Out-of-scope

- **claude/Fable-in-rooms.** `buildRoomsArgs` hardcodes `--runner cursor` (`room-runner.ts`); the driver dispatches cursor-runtime rooms only. A claude-in-rooms runner is a separate Phase-4 item. This phase proves **cursor-runtime N-rooms**.
- **The live rooms-host e2e.** Requires the Linux KVM host (stale access — key `id_rooms_auto` → `Permission denied (publickey)`, host IP drifts). Tracked as the Implementation-plan validation gate below; this PR lands the wiring + the rooms-CLI-double unit tests (green on Windows CI, no host).
- **Rooms resume/attach.** VMs are disposable (spec ED-5) — unchanged.
- **New PR-open code.** `branches[0].branch` surfaces via `get_workflow_run` already (PR-S2); the driver's existing land path opens the PR. No revival of `open_pr`.
- **Widening the receipt runtime vocabulary to rooms.** `receiptRuntimeSchema` and the receipt-package manifest `streamSchema` are deliberately `["local", "cloud"]`; `toParkStreamInput` therefore still strips rooms to `undefined` (unchanged). Teaching the receipt vocabulary about rooms is a receipt-package change with its own blast radius (schema + `manifest.ts` + `report.ts` tally + tests) — a clean follow-up, not driver wiring. Until then a parked rooms stream's receipt `runtime` is `undefined`, exactly as today.

## Validation

- `engine.test.ts` (L2, rooms-CLI double via `createFakeShipPort`):
  - **input shape** — `buildShipInputForTest` on a rooms stream emits `{ runtime: "rooms", room: { repos: [{ url, startingRef }], pushBranch: <branch> }, workdir: repoRoot }`.
  - **cap** — a two-rooms-stream batch under `{ maxParallel: { rooms: 1 } }` dispatches exactly one `startShip` in the tick (peer of the existing "cloud cap limits dispatch" test).
  - **preflight** — a rooms manifest without `repo_url` (or a blank/whitespace one) fails preflight; a rooms stream without `branch_name` (or a blank/whitespace one) fails preflight; a rooms stream with a non-cursor provider (`claude`) is rejected; a blank `base_branch` normalizes to `undefined` (no empty `startingRef` forwarded). Nothing dispatches on any rejection.
  - **branch** — the dispatched rooms `ShipInput` carries the top-level `branch` (= stream branch), so core persists a matching `worktree.branch` and recovery adopts the live VM instead of duplicating it.
- The runner-level `defaultImage` fallback is already covered by `room-runner.test.ts` ("falls back to constructor defaultImage" / `MissingRoomImageError` when neither set). The `SHIP_ROOMS_IMAGE` → `defaultImage` passthrough at the composition root is a trivial env read validated by the e2e (a real `RoomCursorRunner` can't be exercised in a unit test without spawning `sudo rooms`).
- `make check` green (typecheck + lint + format + test) on ubuntu + windows.
- **Validation gate (deferred, tracked):** live `ship.ship { runtime: "rooms" }` fan-out (N≥2) against a fixture on the rooms-host, with `SHIP_ROOMS_IMAGE` set on the host — the spec's portfolio-hypothesis gate. Blocked on rooms-host access refresh; not part of this PR.

## Implementation-plan (PR boundaries)

One PR — the builder, the concurrency lane, the preflight/park edits, and the unit tests are one tightly-coupled state-machine change (~190 weighted, amazing band); splitting the cap from the builder would land a half-wired rooms path. The live e2e is a separate gated follow-up, not a PR.

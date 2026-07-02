# CLI `--runtime rooms` — drive a rooms run from the shell

**Status:** ready for impl
**Owner:** @itsHabib (human:mh)
**Date:** 2026-07-02
**Scope:** ~250 weighted LOC (CLI flags + parse/resolve + guards; test-harness room-runner wiring; command tests). Ideal band, single PR.

## Problem

`runtime: "rooms"` is reachable only through the `ship` MCP tool. The CLI's `--runtime` accepts `local | cloud` and `parseRuntime` throws on anything else; there is no `--room` / `--room-*` flag surface. So a rooms run can't be dispatched from a shell — which is exactly what's needed to drive ship-on-rooms over ssh on the rooms-host (the host runs the agent; the caller is a shell), and later to fan rooms streams out for the multi-room pool.

The "MCP-only" shape was a deliberate focus scaffold when nothing needed to drive rooms from a shell. That's no longer true, so the CLI gains parity with the MCP tool. The core service and `shipInputSchema` already model `runtime: "rooms"` + `room` end-to-end (`ShipServiceConfig.roomCursor`, `refineRuntimeRoomsSpec`); only the CLI surface is missing.

## Functional requirements

- `--runtime rooms` is accepted by `parseRuntime` (alongside `local | cloud`).
- A room spec can be supplied two ways, mirroring `--cloud` / `--cloud-*`:
  - `--room <path>` — a JSON file parsed by `roomRunSpecSchema` (file mode; wins over field flags).
  - Field flags: `--room-repo <url>` (→ `room.repos[0].url`), `--room-starting-ref <ref>` (→ `room.repos[0].startingRef`), `--room-image <path>` (→ `room.image`), `--room-push-branch <name>` (→ `room.pushBranch`).
- `--runtime rooms` with no room spec → clean `InvalidArgumentError` naming `--room-repo` / `--room` (mirror of the cloud guard). The CLI is the validation boundary for direct service callers — it bypasses `shipInputSchema.superRefine`, so the guard lives here too.
- Provider guard: rooms currently supports only the cursor provider (`RoomCursorRunner`); `--provider claude|codex` + `--runtime rooms` fails fast with a clear message (mirrors the MCP schema, where `refineClaudeProviderRuntime` / `refineCodexProviderRuntime` reject rooms). Claude-in-rooms / codex-in-rooms are separate future phases.
- Omitting `--runtime` is unchanged (service default; no `room` field on the input).

## Tradeoffs / decisions

- **Mirror the cloud pattern exactly** — `resolveRoomSpec` is the twin of `resolveCloudSpec` (file-mode wins over field-flags; required-spec guard). Same shape = same mental model, same test coverage structure.
- **rooms = cursor-only, enforced at the CLI.** Rather than reason per-provider, one `enforceRoomsProviderGuard` rejects any non-default provider with rooms. Matches the MCP schema's net effect and fails before a persisted run row.
- **No new schema.** `roomRunSpecSchema` is already exported from `@ship/mcp`; the CLI imports and reuses it (as it does `cloudRunSpecSchema`). No duplication.
- **test-harness gains `roomCursor`.** `createServiceFromHarness` forwards `cloudCursor|claude|cloudClaude|codex` today; add `roomCursor` so the CLI routing test can assert a rooms run reaches the room runner (not the local cursor).

## Edge cases

- `--room <path>` missing / malformed JSON / Zod shape mismatch → exit 1 with a message naming the path / parse error / field (mirror the `--cloud` file tests).
- `--room-repo` present but `--runtime` omitted → the field is built into the input but the service default runtime (local) drops it, same as the cloud field-flags-without-cloud-runtime case (asserted end-to-end).
- `--room-starting-ref` without `--room-repo` → the repo entry needs a url; a starting-ref alone yields no `repos[0]`, so `roomRunSpecSchema.parse` rejects it (empty tuple). Surfaced as a clean argument error.

## Validation

- Unit (command) tests in `packages/cli/test/ship-command.test.ts`, mirroring the cloud block: `--runtime rooms --room-repo` routes to the room runner with `input.runtime === "rooms"` + `room.repos[0].url`; `--room-image` / `--room-push-branch` / `--room-starting-ref` forward; `--room <file>` loads; missing-spec / bad-provider / malformed-file all exit 1 with the right stderr.
- `make check` green (typecheck + lint + format + coverage) on the whole workspace.

## Out of scope

- Claude / codex in rooms (future agent-runner phases).
- The multi-room pool / concurrency (rooms repo) — this is purely the ship-side CLI surface.
- Any change to the MCP tool, the core routing, or `roomRunSpecSchema` (all already present).

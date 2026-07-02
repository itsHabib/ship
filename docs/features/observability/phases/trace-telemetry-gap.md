**Status**: draft
**Owner**: @michael
**Date**: 2026-07-02
**Related**: dossier task `trace-telemetry-gap` (id: `tsk_01KWFS30WNAW71NHCWRWK10H1D`); [docs/features/observability/spec.md](../spec.md) §10 (token/cost axis deferral — this phase lifts the *capture mechanism* only; the analysis axis / cost TDD stays deferred); [docs/features/run-receipt/spec.md](../../run-receipt/spec.md) (receipt `cost_tokens` is this phase's surface-side destination); consumer github.com/itsHabib/tracelens (`tracelens ship <run-ref>`). Item 4 of the dossier task (normalized projection sidecar) is split out as dossier task `trace-normalized-sidecar` — **not this phase**.

# Trace telemetry: per-event timestamps, tool outcome, usage capture

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/service.ts` (ts stamp at the `onEvent` choke point), `packages/agent-runner/src/runner.ts` (`AgentRunResult` usage fields), `packages/claude-runner/src/terminal-map.ts` + `packages/codex-runner/src/terminal-map.ts` (usage lift), `packages/cursor-runner` (outcome passthrough verification / structured exit surface), `packages/receipt/src/runs.ts` (+ `schema.ts` if needed) | ~200 | 200 |
| Tests | ts stamping, outcome mapping, usage lift fixtures, receipt population (existing `runs.test.ts` null assertion flips) | ~300 | 150 |
| **Total** | | | **~350** |

Band: **amazing, may stretch into ideal** with test drift. Single PR.

## Goal

A ship run's persisted trace is step-shaped but blind on three axes: **when** each event happened (no per-event timestamps — no cursor/codex SDK event carries one, so `events.ndjson` rows are undateable), **whether** a tool call's command actually succeeded (a shell step whose command exits nonzero persists as `completed`, indistinguishable from success), and **what the run cost** (`receipts.cost_tokens` is reserved-but-null by design; the claude and codex SDKs hand over per-run `usage` that the terminal maps discard). External trace consumers — tracelens first — can detect loops and stuck states today, but their retry-storm and cost-hotspot detectors are structurally dormant on ship traces. After this phase, new runs persist per-event timestamps and a machine-readable tool outcome, and receipts carry token usage for the providers whose SDKs expose it.

## Behavior / fix

Architectural constraint to preserve: raw SDK events are persisted **verbatim** to `events.ndjson` (`createNdjsonEventWriter` stringifies whatever `onEvent` receives; the per-provider `EventProjection`s are read-time normalizers, not write-time transforms). All three fixes are additive at the seams — no projection becomes a write-path transform, no existing field is renamed.

1. **Per-event timestamps — stamp at the single write choke point.** `packages/core/src/service.ts` `runToTerminal`'s `onEvent` callback is the one place every provider's raw events funnel to disk. Stamp `ts` (ISO-8601 string, `new Date().toISOString()`) onto each event there **iff the event doesn't already carry `ts` or `startedAt`** — never overwrite an SDK-provided timestamp. This lights up all three dialects at once, and the cursor read path already honors it: `cursorEventProjection`'s `parseEventTimestamp` reads `raw["ts"] ?? raw["startedAt"]` today (the accessor exists; the SDK just never feeds it). Write-side clock is acceptable: events arrive streaming, so stamp-at-receipt ≈ event time.
2. **Tool outcome distinguishable from success.** Two sub-cases, split by what the SDK exposes:
   - The cursor SDK's `SDKToolUseMessage.status` union is `"running" | "completed" | "error"` — the `error` literal already exists and verbatim persistence means it already reaches disk when emitted. Add a test pinning that passthrough (no current test asserts an `error`-status row survives to ndjson).
   - The dominant real gap: a shell tool call whose *command* fails (nonzero exit, red test) completes normally at the transport level → `status: "completed"`. Where the completion's `result` payload carries a **structured** exit/error marker (e.g. an exit-code field on cursor's shell result — confirm exact shape at the SDK boundary during impl; `result` is `unknown`-typed), surface it as an additive outcome field on the persisted event row (e.g. `exit_code`, or `ok: false`), stamped at the same core choke point or via a small runner-side enrichment — whichever keeps the projection read-only. **Do not synthesize failure by parsing free-text tool output**; if the payload carries no structured marker, persist nothing extra and state the residual gap in the PR body.
3. **Usage capture — extend the neutral terminal type and lift what the SDKs already hand over.** `AgentRunResult` (`packages/agent-runner/src/runner.ts`) gains optional usage fields (e.g. `usage?: { inputTokens, outputTokens, totalTokens }` + `costUsd?`). Then:
   - `packages/claude-runner/src/terminal-map.ts` `mapResultMessage`: the terminal `result` message carries `usage.{input_tokens,output_tokens,cache_*}` and `total_cost_usd` — lift both (today's success branch returns only `{branches, durationMs, status, summary}`).
   - `packages/codex-runner/src/terminal-map.ts`: `turn.completed` carries `usage: { cached_input_tokens, input_tokens, output_tokens, reasoning_output_tokens }` — lift it.
   - Cursor: the SDK's `RunResult` has no usage of any kind — receipt stays null for cursor runs; document that in the PR body.
   - Core already serializes `AgentRunResult` into `result.json` (`tryWriteSuccessArtifacts`) — the new fields ride along. Then `packages/receipt/src/runs.ts` `runResultToReceipt` extends its `resultSchema` to read the usage fields and maps `cost_tokens` from total tokens instead of the hard-coded `null` (the schema comment "Populated by a later phase" — this is that phase). `receiptSchema` already has `cost_tokens` nullable — no receipt schema-version bump needed for populating an existing field.

**Compatibility posture (state this in the PR):** every change is an additive field on new runs — `ts`/outcome keys on event rows, optional fields on `AgentRunResult`/`result.json`, a previously-null receipt field becoming populated. Consumers that ignore unknown fields (tracelens's decoder does, by design) are unaffected; no rename, no removal, no rewrite/backfill of historical runs; `events.ndjson` rows for providers/paths that expose nothing extra are byte-identical to today.

## Acceptance

- A fresh run's `events.ndjson` (any provider) has `ts` on every event row; an SDK-provided `ts`/`startedAt` is never overwritten.
- A cursor `tool_call` with SDK `status: "error"` survives verbatim to disk (pinned by test). A completed shell call whose structured result marks failure yields a machine-readable outcome field on its persisted row — no free-text parsing.
- A fresh claude-runner run's `result.json` carries usage + cost, and its receipt (`ship-receipt build`) has non-null `cost_tokens`; same for codex from `turn.completed` usage; cursor receipts stay null and the PR body says why.
- Existing field names/meanings unchanged; `make check` green (including the flipped `runs.test.ts` null assertion).

## Test plan

- core/ndjson seam: onEvent stamps `ts` when absent; preserves SDK `ts`/`startedAt`; additive fields round-trip through `createNdjsonEventWriter` (`packages/core/src/artifacts/ndjson.test.ts` + `service.test.ts`).
- cursor-runner: `error`-status passthrough pin; structured-exit outcome surfacing with + without a usable marker (`packages/cursor-runner/test/cursor-event-projection.test.ts` + `_shared.test.ts` as fits).
- claude-runner/codex-runner terminal maps: usage + cost lifted from the existing stream fixtures (`terminal-map.test.ts` in each).
- receipt: `runResultToReceipt` maps usage → `cost_tokens`; stays null when `result.json` has no usage (`packages/receipt/src/runs.test.ts` — update the current `toBeNull()` assertion to cover both branches).

## Non-goals

- The normalized projection sidecar (dossier task `trace-normalized-sidecar` — its own design pass).
- Cost *analysis* (stats, per-step attribution, pricing tables) — the §10 cost TDD stays deferred; this is capture only. Receipt auto-append on merge (run-receipt rollout Phase 4) is untouched.
- Backfilling or rewriting historical runs; no store migration (receipts are JSONL, outside `@ship/store`; nothing here touches SQLite).
- Per-step usage attribution — per-run totals only; don't fabricate a per-step split from totals.
- tracelens-side mapping of the new fields (tracked in the tracelens repo, task `map-ship-telemetry-fields`).
- Cursor usage — its SDK exposes none; nothing to capture.

## Implementation plan

1. `@ship/core`: `ts` stamp at the `onEvent` choke point in `runToTerminal` (+ seam tests).
2. `@ship/cursor-runner`: `error`-status passthrough pin; structured shell-exit outcome surfacing where the result payload carries it (+ table tests).
3. `@ship/agent-runner`: optional usage/cost fields on `AgentRunResult`.
4. `@ship/claude-runner` + `@ship/codex-runner`: terminal-map usage lifts (+ fixture tests).
5. `@ship/receipt`: `resultSchema` extension; `cost_tokens` population (+ both-branch tests).

Single PR (~350 weighted); steps are one telemetry surface threaded through the layers, not independent shippables.

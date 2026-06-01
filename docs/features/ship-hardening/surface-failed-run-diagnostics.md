**Status**: draft
**Owner**: @michael
**Date**: 2026-06-01
**Related**: dossier task `surface-failed-run-diagnostics` (id: `tsk_01KT1QZW3XPNF0FDYMQZAAZAAP`)

# Ship discards SDK failure diagnostics — surface them on failed runs

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/cursor-runner/src/_shared.ts` (`mapErrorResult`), `packages/cursor-runner/src/local-runner.ts` (throw path), `packages/core/src/service.ts` (`get_workflow_run` view ~L190), `packages/mcp/src/mcp.ts` (`getWorkflowRunOutputSchema` ~L189) | ~90 | 90 |
| Tests | `packages/cursor-runner/src/local-runner.test.ts` (update L334 + new case), `packages/mcp/src/mcp.test.ts`, `packages/core/src/service.test.ts` | ~100 | 50 |
| **Total** | | | **~140** |

Band: **amazing** (< 500).

## Goal

> Operator: "no insight into why a run failed is unacceptable."

A local run failed with the opaque `errorMessage: "Cursor SDK reported error without a message"` — yet ship **had** the real cause and threw it away. Hit 2026-06-01 driving the ship-hardening batch: three concurrent local runs all failed at the same wall-clock second; the dossier one said `database is locked`, the two ship ones surfaced the generic string. The lock-contention text was in the event stream the whole time. This task is purely about not *hiding* failures — surface the signal ship already has.

## Behavior / fix

Two error sinks exist in `cursor-runner`:

1. **Throw path** (`local-runner.ts:213-217, 227-232`): when `stream()`/`wait()` *reject*, ship builds `CursorRunFailedError({ cause })` — preserves the SDK error. Mostly fine, but verify the wrapped `cause`'s message actually reaches `errorMessage`, not just the wrapper text.
2. **Clean-terminal-error path** (the one these runs took): the SDK did NOT throw — `wait()` resolved a `RunResult` with `status: "error"` and an empty `result`. `mapErrorResult` (`_shared.ts:134-142`) does `errorMessage: result.result ?? "Cursor SDK reported error without a message"` — it only reads `result.result` (the agent's final assistant text), which is empty on an abrupt error. Everything else is discarded.

Dropped signal ship already held: raw `RunStatus: "ERROR"` (in events as `{"type":"status","status":"ERROR"}`); the last `tool_call` event's error `result`; `durationMs` (~27m) vs `maxRunDurationMs` (30m) → "stalled near timeout"; and per the SDK doc `CursorAgentError.{code,isRetryable,cause,protoErrorCode}`.

The fix, three parts:

1. **`mapErrorResult` builds a richer message.** Include the SDK `RunStatus`; scan the captured events for the last error-bearing `tool_call`/status event and fold its detail in. The generic string becomes the last resort, not the default. Shape example:
   > `SDK status ERROR after 27m (cap 30m); last tool_call errored: database is locked`
2. **`get_workflow_run` exposes enough to diagnose without grepping `events.ndjson`:** `durationMs` + the policy cap (`maxRunDurationMs`), the raw SDK terminal status, and the last-N events (or a pointer to them). Add the fields to `getWorkflowRunOutputSchema` (`packages/mcp/src/mcp.ts`) and populate them in the run view (`packages/core/src/service.ts` ~L190).
3. **Throw path** (`local-runner.ts`): ensure `CursorRunFailedError.cause`'s message reaches `errorMessage`, not just the wrapper.

## Acceptance

- A clean-terminal `status:"error"` run surfaces a message naming the cause (`database is locked`, or `SDK status ERROR after 27m (cap 30m); last tool_call errored: <…>`) — not the generic string.
- `get_workflow_run` carries duration-vs-cap + the SDK terminal status.
- Unit test: a fake SDK run resolving `status:"error"` with an error-bearing `tool_call` event → `errorMessage` includes that detail. **NB** `local-runner.test.ts:334` currently *asserts* the generic fallback — that test encodes the bug; update it to assert the richer message.

## Test plan

- Update `local-runner.test.ts:334` (the generic-fallback assertion) → assert the folded-in detail.
- New `local-runner.test.ts` case: fake `RunResult { status: "error", result: undefined }` plus an error-bearing `tool_call` event → `errorMessage` includes the tool_call detail and the SDK status.
- `mcp.test.ts`: `getWorkflowRunOutputSchema` accepts the new diagnostic fields (duration cap, SDK terminal status, last-N events) and round-trips them.
- `service.test.ts`: `get_workflow_run` view carries `durationMs` + cap + terminal status for a failed run.

## Non-goals

- Fixing the underlying `database is locked` contention — that's the sibling task `ship-store-write-contention`, which **depends on this** (a clean contention error needs the diagnostics surface). This task only stops hiding the cause.
- Retry/backoff policy on retryable SDK errors. Out of scope; surface `isRetryable` if cheap, but don't act on it here.

**Status**: draft
**Owner**: @michael
**Date**: 2026-07-12
**Related**: dossier task `driver-orphan-refresh-non-streaming` (id: `tsk_01KV4R52CFTAPT8NE5MTTNFF8G`); PRs #138 (fire-and-forget resume) and #139 (event-pump unref), plus their codex findings.

# Non-streaming orphan refresh — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/service.ts` (new `refreshOrphanedRuns`), `packages/core/src/cursor-runs/cloud-runner.ts` (reuse `Agent.getRun` read path), driver `DriverShipPort` + `run` tick | ~180 | 180 |
| Tests | terminal-orphan harvest, still-running left untouched, prompt process exit | ~200 | 100 |
| **Total** | | | **~280** |

Band: **amazing** (< 500). Single PR.

## Goal

The driver tick resumes orphaned cloud runs via `ShipService.resumeOrphanedRuns` — a **streaming re-attach** (SDK event stream + heartbeat pump + duration-cap timer) built for the long-lived mcp-server. In a short-lived CLI tick it (1) holds the process open past `--max-wait 0` (ref'd pump timer, cap timer, SDK socket — codex #138 P2), (2) can't be bounded by abort because the per-run `AbortController` is wired to `sdkRun.cancel()` — aborting *cancels the cloud agent's run* (codex #138 cycle-3 P1), and (3) unref whack-a-mole is partial and unsafe — unref'ing the cap timer breaks foreground `ship ship` (codex #139 cycle-2 P1); the socket can't be unref'd at all.

## Behavior / fix

Add a **non-streaming, one-shot orphan refresh** for the driver tick:

- Per orphaned cloud run, a single `Agent.getRun` (already used inside `CloudCursorRunner.attach`) reads current terminal state — **no** event stream, pump, or cap timer.
- Terminal → write the result to the store (finalize, harvest). Still running → leave the row untouched; a later tick refreshes again. The staleness guard still applies.
- Expose as `ShipService.refreshOrphanedRuns`, thread through `DriverShipPort`; the driver `run` tick calls it. No lingering handles, no abort/cancel path needed.
- The streaming `resumeOrphanedRuns` **stays** for the mcp-server boot/periodic sweep (long-lived host wants stream-to-completion).
- Folds in the deferred duration-cap conditional-unref — moot because the refresh never arms the cap.

## Acceptance

- `ship driver run --max-wait 0` that harvests a terminal orphan returns control to the shell promptly (no held-open handles).
- A still-running orphan is left untouched — not cancelled, not streamed — and is harvested on a later tick once terminal.
- Foreground `ship ship` duration-cap behavior unchanged.
- The kill+resume gate passes: re-tick after staleness harvests the finished orphan in one fetch.
- `make check` green.

## Non-goals

- Changing the mcp-server's streaming resume path.
- Liveness/heartbeat semantics of the pump (`event-pump-blinds-tick-liveness`, separate PR later in this manifest).

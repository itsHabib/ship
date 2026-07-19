**Status**: draft
**Owner**: @mh
**Date**: 2026-07-19
**Related**: dossier task `fallback-engine-hop` (id: `tsk_01KXE9XW4FWYRMZY597S2VWRG3`), design [../spec.md](../spec.md) §4.2–§4.6, §7.2–§8, §9 P2a

# Engine hop on dispatch failure (dispatch-fallback P2a) — phase doc

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/engine.ts` (both seams), `packages/driver/src/escalation.ts`, small store patch surface | ~250 | ~250 |
| Tests | unit (eligibility, gate, reset patch), property (cursor monotonicity), e2e fake-runner both seams | ~300 | ~150 |
| **Total** | | | **~400** |

Band: **amazing** per repo PR sizing. The reshape that split P2b out of this task
(2026-07-13) exists precisely to hold this line — if the impl drifts past ~700
weighted, stop and re-read Out of scope.

## Goal

A pre-work environmental dispatch failure (dead provider, gateway auth/unreachable)
on a stream with a declared fallback chain hops to the next viable target instead of
parking at `failed → awaiting_judgment`. Streams carrying work never hop. Everything
ineligible behaves byte-identically to today.

## Behavior

- **Eligibility constant** per spec §4.2: `sdk-throw` (sync, dispatch catch),
  `gateway-unreachable` + `gateway-auth` (async pre-work, poll seam via
  `classifyFailure`). `budget-exceeded` and `contention` NOT eligible. Everything
  else escalates as today.
- **No-work-products gate (§4.3):** hop only when `(reviewCycles ?? 0) === 0` AND
  no genuine PR — reuse the engine's real-PR discrimination (`isAddressRedispatch`;
  a failed flip persists `prUrl`, so `reviewCycles` is load-bearing). The
  cloud-autoPR-at-reviewCycles-0 case must block the hop. Applies at BOTH seams; a
  work-carrying stream never hops.
- **Two hook seams:** `dispatchStartShip` catch (sync) AND `pollOneStream`
  terminal-failure handling (async — `runShipStart` returns via `setImmediate`
  before failures surface, so the flagship bad-credential case arrives at the poll
  seam). The gate is a pure predicate over already-loaded columns.
- **Viability (§4.6): CONSUME the landed helper — do not rebuild.**
  `checkTargetViability(target, deps)` + `createViabilityDeps` shipped in #207
  (`packages/driver/src/viability.ts`, exported from `@ship/driver`) with the
  per-cell env table and live cursor-catalog check. The ONLY delta: it does not
  check local-worktree existence (`.claude/worktrees/<branch>`); add that at the
  hop site or extend the helper. Consume the landed
  `DispatchTarget { runtime, provider, modelId }` vocabulary.
- **`FALLBACK_RESET_PATCH`** (§7.2, minus `targetModelId` — P2b): everything
  `PENDING_RESET_PATCH` clears + runtime/provider rewritten +
  `workOnCurrentBranch: false` (cloud-flip inheritance) + `fallbackCursor` advanced
  + hop record appended + #199 breaker window reset. Note P1 landed a schema
  invariant: `fallbackChain`/`fallbackCursor`/`fallbackLog` travel together — the
  patch updates cursor+log on a row that already carries the chain, never a subset
  on a chainless row.
- **Chain walk (§7.2 steps 4–5): in-memory** — accumulate skip records + cursor
  advance, then ONE atomic `updateDriverStream` patch (viable → step 5; exhausted →
  step 7). Never N+1 per-skip writes. Length-N chains and length-1 run the same loop.
- **#199 breaker interplay (§7.2 step 0):** while a stream has unconsumed chain,
  the consecutive-dispatch-failure breaker does not park it; a hop resets the
  window; exhaustion emits ONE escalation subsuming the breaker copy. Re-check the
  escalation/awaiting_judgment surface against #204/#206 (park receipts) before
  building §6.
- **§6 escalation copy:** subject
  `dispatch failed after fallback: <stream> exhausted <n>-target chain`; body lists
  primary + each entry outcome (hopped / skipped+remedy); the terminal `failed:`
  line is **derived** from the terminal attempt row category + current
  runtime/provider (`fallbackLog` has no failure record); closes by naming which
  target a bare `decide retry` re-fires (current columns = last target).
- P1 export note: the engine's implicit provider default is now the exported
  `DEFAULT_DISPATCH_PROVIDER` (engine.ts) — import validation already seeds dupe
  detection with it; the hop walk must treat an implicit-cursor primary the same way.

## Acceptance

- Eligible pre-work failure + viable target: zero `decide` interactions; completes
  on the hop target; runtime/provider columns reflect it (`/provenance` correct for
  runtime+provider; model attribution arrives with P2b).
- Work-carrying stream (`reviewCycles > 0` fixture) + eligible category does NOT
  hop at either seam.
- Ineligible / empty / exhausted: byte-identical to today at both seams; escalation
  per §6, no separate #199 breaker escalation.
- Skips loud: recorded in `fallbackLog` + rendered first-class; credential skips
  carry remedy lines.
- Cursor monotonic; each target tried at most once (no retry — P2b);
  decide-retry-post-exhaustion → exactly one new escalation, no re-walk.

## Test plan

Unit: eligibility table; work-products gate (each signal incl. cloud-autoPR);
worktree-existence viability delta; `FALLBACK_RESET_PATCH` columns incl.
`workOnCurrentBranch`. Property: cursor monotonicity. e2e (fake runners, BOTH
seams): sync throw → hop; async pre-work → hop; work-carrying + eligible → no hop
(incl. poll-seam case); multi-hop; skip-then-hop; exhaustion escalates once with
derived `failed:` line.

**VALIDATION GATE (post-merge, operator-run):** real run, cloud primary with
deliberately invalid credential (arrives via poll seam) → lands unattended on
`(local, claude)`, legible hop record. P2b stays gated until this passes.

## Out of scope

Transient retry (§4.7) → P2b. `model_id` dispatch honoring / `targetModelId`
column → P2b. `decide retry --target` → P3. Mid-run fallback → P4. Rebuilding the
viability helper or its env table (landed in #207).

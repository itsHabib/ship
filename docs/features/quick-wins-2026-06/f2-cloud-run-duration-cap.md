# F2 — enforce `policy.maxRunDurationMs` over hung cloud runs

**Status:** shipped
**Owner:** operator + Claude
**Date:** 2026-06-10
**Scope:** ~290 weighted LOC (impl ~110 × 1.0, tests ~360 × 0.5)

## Problem

`policy.maxRunDurationMs` (default 30 min) was documented as "Ship cancels the
run after this" but never enforced on any awaited path. Both `runToTerminal`
and the cloud-resume attach awaited `handle.result` unbounded. Local runs only
ever terminate because the SDK's own agent timeout expires; a hung cloud agent
holds the stream open forever, leaving the workflow row `running` indefinitely
with no branch and no PR. Observed 2026-06-10 (friction log F2): a cloud run
still `running` at 60+ minutes; a manual cancel + re-dispatch succeeded in
4.6 minutes.

## Functional

- New `runWithDurationCap` in `@ship/core` (`cursor-runs/duration-cap.ts`)
  runs the whole start → terminal sequence under a single cap window: the
  window opens *before* the SDK start/attach call, so a stalled
  `Agent.create` / `agent.send` / `Agent.resume` is bounded the same as a
  hung agent run (codex review caught the attach gap on the first cut).
- Expiry with a live handle resolves a synthetic `failed` terminal and fires
  a best-effort `handle.cancel()` (not awaited — a hung agent may never
  acknowledge). The synthetic result carries `durationMs >= maxRunDurationMs`
  and no classification events, so the existing `classifyFailure` lands on
  `timeout-near-cap` deterministically; callers (work-driver, future
  `@ship/driver`) get a terminal `failed` + `failureCategory` to triage
  instead of polling forever.
- Expiry *before* a handle exists rejects `CursorRunStartTimedOutError`
  (classified `sdk-throw` — the SDK start call hung, not the agent run); a
  handle arriving after expiry is cancelled and never registered, so no
  pump/registry bookkeeping outlives the finalized run.
- Both sites are guarded: fresh dispatch (`runToTerminal`) and cloud resume
  (`runResumeAttach`). On resume the window is the *remaining* budget
  (`cap − elapsed since the cursor run started`), floored at a 60s grace
  window — itself clamped to the cap, so the grace never grants more than
  `maxRunDurationMs` — so an already-terminal run can still deliver its real
  result while a process restart doesn't re-grant a hung run the full cap.

## Tradeoffs / EDs

- **ED-1: guard lives in core, not the runner.** The cap is Ship policy;
  runners stay policy-free mechanism. The guard wraps `handle.result`
  uniformly, so local and rooms runs get the same backstop for free.
- **ED-2: cap verdict is `failed`, not `cancelled`.** `cancelled` is reserved
  for operator intent (`cancelRun`). The synthetic terminal is resolved
  *before* cancel fires so a runner whose cancel settles `result`
  synchronously can't flip the verdict to `cancelled`.
- **ED-3: cancel is fire-and-forget.** Waiting on a cloud round-trip to a hung
  VM would reintroduce the unbounded wait the guard exists to remove.
- **ED-4: synthetic result omits events/branches.** A run that hit the cap has
  no trustworthy terminal payload; diagnosis flows through `failureDetail`
  ("duration X (cap Y)") and the persisted `events.ndjson` tail.
- **ED-5: timer delay clamped to `MAX_TIMER_DELAY_MS` (2³¹−1).** The policy
  schema accepts any positive int, but Node coerces a `setTimeout` delay above
  the 32-bit signed max to 1ms — which would misfire a multi-week cap
  instantly. The clamp fires at ~24.9 days instead; the synthetic terminal
  still reports the configured cap as its duration (the clamp only bounds the
  physical wait). Caught by codex review.
- **ED-6: the whole start→race sequence runs inside one `try/finally`.** An
  injected runner that throws *synchronously* (rather than returning a rejected
  promise) must still clear the armed cap timer. Both production callers are
  async, but the guard is free. Caught independently by codex + claude.
- **ED-7: explicit race-loser swallowers.** `Promise.race` already retains a
  reaction on each input, so the loser settling late is observed, not actually
  unhandled — but sibling `.catch` handlers make that host-independent and
  self-evident. Raised by cursor bugbot.

## Validation

- L1 (`packages/core/src/cursor-runs/duration-cap.test.ts`): pass-through,
  start/result rejection propagation, post-handle cap expiry shape,
  pre-handle expiry (`CursorRunStartTimedOutError` + late handle cancelled,
  never registered), swallowed cancel rejection, resume-window arithmetic,
  grace floor + its cap clamp, late-result-beats-synthetic.
- L2 (`packages/test-harness/scenarios/core-duration-cap.scenario.test.ts`):
  fake timers + `FakeCursorRunner` scripted to never terminate — fresh cloud
  dispatch fails `timeout-near-cap` at the cap with the cancel reaching the
  runner; a resumed run gets only its remaining budget, not a fresh window.
- `make check` green.

## Risks

- A run that would have succeeded just past the cap is now failed at it. By
  policy that's correct; the cap is configurable per-run if a workload needs
  more headroom.
- The SDK-side cancel is best-effort: a truly wedged cloud VM may keep
  consuming cursor-side resources after Ship marks the run failed. Ship-side
  state is no longer hostage to it, which is the contract that matters here.

## Out of scope

- Marking the cloud PR ready / draft handling (F1 in the same friction batch).
- A per-call `maxRunDurationMs` override on the `ship` tool input (policy is
  still always `DEFAULT_WORKFLOW_POLICY` at dispatch).
- Cloud-side cancel for orphaned rows whose parent workflow is already
  terminal (pre-existing TODO in `closeOrphanedCursorRowToMatchTerminalWorkflow`).

## Implementation plan

1. `awaitResultWithDurationCap` + synthetic-terminal builder (core).
2. Wire into `runToTerminal` and `runResumeAttach`; `resolveMaxRunDurationMs`
   narrowed to take `Store`.
3. Correct the stale `WorkflowPolicy` doc comment (`cancelled` → `failed` +
   `timeout-near-cap`).
4. L1 + L2 tests per Validation.

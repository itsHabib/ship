**Status**: draft
**Owner**: @michael
**Date**: 2026-07-09
**Related**: dossier task `ccp-driver-address` (id: `tsk_01KWHFY3FVRB6YRB91W3AVM98F`), phase `ccp-loop-closure`, TDD `docs/features/cloud-control-plane/spec.md` §6 + §7 Flow B, synthesis C10

# `driver address` — re-dispatch consolidated review findings onto the existing PR branch

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/engine.ts` (verb + dispatch-input lift), `packages/driver/src/types.ts`, `packages/driver/src/service.ts`, `packages/cli/src/commands/driver.ts`, `packages/store/src/driver-schemas.ts` + `packages/store/migrations/0014_driver_streams_review_cycles.sql` | ~380 | 380 |
| Tests | `packages/driver/src/engine.test.ts`, CLI + store tests | ~380 | 190 |
| **Total** | | | **~570** |

Band: **ideal**. No-split justification: the verb, its dispatch-input lift, and the
cycle counter are one state transition — a verb that re-dispatches without counting
cycles (or vice versa) leaves the cycle cap unenforceable.

## Functional

There is no way to push consolidated review findings back into a landed cloud PR.
`judgment.ts` decide kinds (`retry|skip|abort|adopt`) only re-dispatch *failed*
streams; the dispatch path builds fresh-branch cloud runs, so review-fix falls off
the engine rails and lives in `/work-driver` + `/review-coordinator` prose. This is
the every-cloud-run bottleneck — the backtest behind the workbench-redesign verdict
showed the judgment/review-fix loop firing on 5 of 7 real PRs.

New engine verb, mirroring `land`/`decide` in shape:

```
ship driver address <driverRunId> --stream <streamId> --findings <path>
```

**Mechanism only.** *Which* findings to take and *whether* to push back stays
seat-side (`/review-coordinator` + seat judgment). The engine carries the findings
file opaquely — no parsing, no selection, no policy.

What the verb does, in order:

1. **Validate addressability** (structured refusals, never silent no-ops — see
   *Refusals* below): stream exists, is `landed`, has `prNumber` + `branch`, PR is
   open, run is not cancelled/mid-dispatch, cycle cap not exhausted.
2. **Read the findings file** and embed it verbatim in the re-dispatch input under a
   fixed mechanical preamble ("address the following review findings on the current
   branch; do not open a new PR"). The findings path is recorded on the attempt row
   (`StreamAttempt.docPath`) for the audit trail.
3. **Re-dispatch onto the existing PR branch** by reusing the branch-continuation
   mechanism that `flipStreamToCloud` already exercises: pass
   `CloudContinuation { startingRef: stream.branch, workOnCurrentBranch: true }`
   into `dispatchStream`. One lift inside `buildShipInput`: it currently
   hardcodes `cloud.autoCreatePR: true` — correct for flip-cloud, whose streams
   have no PR yet — so the address path must send it `false` (a PR already
   exists; the run pushes to the branch). The rest is landed `#180` threading
   (`buildShipInput` → `ShipInput.cloud.repos[0].startingRef` +
   `cloud.workOnCurrentBranch`); no new runner plumbing.
4. **Increment the stream's review-cycle counter** (`reviewCycles`, migration
   `0014`) in the same transition that flips the stream back to `dispatched`.
5. **Return the updated `DriverRun`.** Polling to terminal is not a new loop: the
   stream re-enters the existing `runDispatchPollLoop` on the next `driver run`
   tick, exactly as a flip-cloud re-dispatch does. Terminal-succeeded lands the
   stream back at `landed` with the same PR, ready for the seat's next review pass
   or `driver land`.

### State machine

`address` is only legal from `landed` (workflow succeeded, PR open, awaiting
merge):

```
landed --address--> dispatched --poll--> landed   (terminal-succeeded, same PR)
                              \--poll--> failed   (terminal-failed → decide, as today)
```

- `pending|dispatching|dispatched`: refuse — the stream is still in flight.
- `failed`: refuse — that's `decide retry`'s lane, which re-dispatches fresh.
- `skipped|done`: refuse — terminal; `done` means the PR already merged.
- Run status: `address` is legal while the run is `running` or
  `awaiting_judgment`; refused on `cancelled|failed|done`... with one carve-out:
  a run that reached `done` while its stream is still `landed` cannot exist
  (exit evaluation requires streams terminal), so no special case is needed.

### Cycle cap

The TDD fixes the review-cycle cap at 3 (§7 Flow B: terminal → re-request
reviewers → cycle++ → approval → land; cap exhausted with open actionables →
`cycle-exhausted` escalation, page-tier). The cap is enforced here as a
*mechanism guard with a policy-supplied value*: `AddressOpts.maxCycles`
(default 3, threaded from run opts like other engine knobs). An `address` call at
the cap writes a `cycle-exhausted` escalation row via the existing `#178`
machinery (open-row dedup on `(run, stream, class)`) and refuses — the notify
hook pages the operator; the seat decides what happens next. The counter is
`reviewCycles` on `driver_streams`, not attempt-array length: initial dispatch
and `decide retry` attempts must not count against review cycles.

### Refusals

Structured errors in the `land`/`decide` family (a `PreconditionError`-shaped
code + message), one per condition: `no-pr` (stream has no `prNumber`/`branch`),
`pr-not-open` (merged/closed), `not-landed` (stream status outside `landed`),
`run-not-addressable` (cancelled/failed run), `cycle-exhausted` (cap reached —
also writes the escalation row), `findings-unreadable` (missing/empty file).

### Runtime scope

Cloud streams only in this PR. A `landed` **local** stream is refused
(`not-cloud`) — the documented skill-side fallback (seat fixes in the local
worktree directly) already covers it, and `flip-cloud` exists for a local stream
the operator wants on the cloud rails. Lifting `address` to local runtimes is a
follow-on if the refusal ever bites in practice.

## Tradeoffs

- **Reuse `CloudContinuation` rather than a new dispatch shape.** The address
  path is behaviorally identical to flip-cloud's re-dispatch (same branch, same
  no-new-PR contract) plus an embedded findings block. One mechanism, two
  callers — the alternative (a parallel `AddressDispatch` input type) duplicates
  the §180 threading for no semantic gain.
- **`reviewCycles` as a column, not attempt-array arithmetic.** Deriving cycles
  by counting `attempts[]` entries with a `kind` marker was considered; rejected
  because attempts already conflate dispatch retries (§7.3 recovery re-dispatch,
  `decide retry`) and the cap must never move because an unrelated retry
  happened. A dumb counter the verb owns is auditable and migration-cheap.
- **Findings as a file path, not a GitHub fetch.** `DriverGhPort` stays
  merge-tail-scoped (view/readiness/merge/markReady). The seat already holds the
  consolidated verdict (that's `/review-coordinator`'s output); making the engine
  fetch comments would drag findings *selection* — policy — into the mechanism
  layer.
- **No auto-trigger from review events.** `address` fires only when the seat
  calls it. Event-driven review-fix is a policy loop that belongs above the
  engine (and is exactly what C14's grant discipline will need to bound).

## EDs (engineering decisions)

1. `AddressOpts = { streamId, findingsPath, maxCycles? }`; verb signature
   `address(store, ship, driverRunId, opts): Promise<DriverRun>` — `ship` port
   needed because it dispatches, unlike `land` which takes the `gh` port.
2. The findings block is embedded into the ShipInput task text; the original
   spec docPath is *not* re-sent (the agent is fixing review findings, not
   re-implementing the spec). `StreamAttempt.docPath` records the findings path.
3. `flipCloudDraftReady` (the `#177` poll-boundary flip) is a no-op for address
   re-dispatches — the PR is already ready; nothing to guard.
4. No MCP surface in this PR — `driver_address` parity rides
   `ccp-mcp-verb-parity` (Phase 2), keeping this PR inside the sizing band.
5. Migration number `0014` (0011 is skipped in-tree; 0012 continuation and 0013
   escalations are landed).

## Validation

- Unit (`engine.test.ts`): address on a `landed` cloud stream → dispatch input
  carries `startingRef == stream.branch`, `workOnCurrentBranch: true`, no
  `autoCreatePR`, findings block present; `reviewCycles` increments exactly
  once per call; refusal matrix (`no-pr`, `pr-not-open`, `not-landed`,
  `not-cloud`, `findings-unreadable`) each return the structured code and leave
  the stream row untouched; call at `maxCycles` → refusal + `cycle-exhausted`
  escalation row written once (dedup on the open row).
- Store: migration 0014 round-trips `reviewCycles` (defaults 0 for existing
  rows); counter survives a store reopen.
- L2 scenario: `landed` → address → `dispatched` → poll terminal-succeeded →
  `landed` again with `reviewCycles == 1` and the same `prNumber`.
- `make check` green (ubuntu + windows matrix).

## Risks

- **Agent force-push / branch divergence.** The cloud agent works on the live PR
  branch; a concurrent local edit to the same branch can conflict. Accepted:
  identical exposure to flip-cloud today; the seat owns not racing its own
  branch.
- **Findings staleness.** The seat may address findings already fixed by a later
  commit. Mechanism doesn't guard this; the re-review cycle catches it.
- **Cap bypass by `decide retry`.** A failed address re-dispatch can be retried
  via `decide` without bumping `reviewCycles` (retry ≠ new cycle). Deliberate:
  the cap counts *review* cycles, not infra retries — noted here so it isn't
  re-litigated as a bug.

## Out of scope

- Findings selection/consolidation policy (`/review-coordinator`, seat-side).
- Auto-triggering address from review events.
- The local fix-worktree skill fallback (documented fallback, not built).
- MCP verb parity (`ccp-mcp-verb-parity`, Phase 2).
- Merge authorization / grants (C14 — that one takes the adversarial
  break-the-gate pass; this verb grants no authority and merges nothing).

## Implementation plan

1. Migration `0014_driver_streams_review_cycles.sql` + `driver-schemas.ts`
   field (`reviewCycles`, default 0) + store round-trip test.
2. `address()` in the engine: validation → findings read → continuation
   dispatch (reusing `resolveCloudContinuation` override) → cycle bump; refusal
   taxonomy in `types.ts`; `cycle-exhausted` escalation wiring.
3. `service.ts` factory method + CLI verb (`driver.ts`), mirroring `land`'s
   registration; JSON output via the existing formatter.
4. Tests per *Validation*; update `docs/features/cloud-control-plane/spec.md`
   checklist row for the verb.

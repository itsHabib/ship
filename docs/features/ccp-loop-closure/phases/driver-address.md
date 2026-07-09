**Status**: draft
**Owner**: @michael
**Date**: 2026-07-09
**Related**: dossier task `ccp-driver-address` (id: `tsk_01KWHFY3FVRB6YRB91W3AVM98F`), phase `ccp-loop-closure`, TDD `docs/features/cloud-control-plane/spec.md` §6 + §7 Flow B, synthesis C10

# `driver address` — re-dispatch consolidated review findings onto the existing PR branch

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/engine.ts` (verb + dispatch-input lift + flip-skip + latest-attempt docPath resolution), `packages/driver/src/types.ts`, `packages/driver/src/service.ts`, `packages/cli/src/commands/driver.ts`, `packages/claude-runner/src/*` (condition the prBranch open-a-PR delivery instructions on PR-exists), `packages/store/src/driver-schemas.ts` + `packages/store/migrations/0014_driver_streams_review_cycles.sql` | ~420 | 420 |
| Tests | `packages/driver/src/engine.test.ts`, claude-runner prompt test, CLI + store tests | ~400 | 200 |
| **Total** | | | **~620** |

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
   *Refusals* below): stream exists, is `landed`, runtime is cloud, has `prUrl` +
   `branch` (the cloud landing path persists `prUrl`/`branch` via
   `buildPrMetaPatch`; `prNumber` is only written later by `land`/`markMerged`,
   so the precondition must key off `prUrl`), the PR is open — checked live via
   `gh.viewPullRequest` with the number parsed by the existing `prNumberFromUrl`
   — run not cancelled/failed, cycle cap not exhausted.
2. **Synthesize the address doc**: a fixed mechanical preamble ("address the
   following review findings on the current branch; do not open a new PR")
   prepended to the findings file's content, written adjacent to the run
   manifest — `<manifest-dir>/address-<streamId>-cycle<N>.md` — so the exact
   dispatched text is auditable. That synthesized file is the dispatch
   `docPath`, and it needs a mechanism: `dispatchStream` today always derives
   `docPath` from `stream.specPath` via `resolveStreamDocPath`, so it gains an
   optional `docPath` override (a small, local parameter — `buildShipInput`
   already accepts an explicit path). The attempt row records the synthesized
   doc (`StreamAttempt.docPath`), and the tick-path re-dispatch resolves the
   *latest attempt's* recorded docPath before falling back to
   `stream.specPath` — so a `decide retry` of a failed address re-runs the
   findings doc, never the original spec, without any retry-specific plumbing.
3. **Persist the continuation, then re-dispatch onto the existing PR branch.**
   Address patches the stream row first — `workOnCurrentBranch: true` — and then
   dispatches via the same `CloudContinuation` path `flipStreamToCloud`
   exercises. Persisting (rather than only passing the one-shot override into
   this one `dispatchStream` call) is load-bearing: a failed address re-dispatch
   retried via `decide retry` re-enters the tick path, which resolves the
   continuation from the *stream row* (`resolveCloudContinuation(stream)`) — so
   the retry stays on the PR branch instead of silently forking a fresh one.
   One lift inside `buildShipInput`: it currently hardcodes
   `cloud.autoCreatePR: true` — correct for fresh dispatch and flip-cloud, whose
   streams have no PR yet — and the cloud runner defaults an *omitted* value to
   `true` (`spec.autoCreatePR ?? true`), so the lift is a mechanism rule keyed on
   persisted state, sending an explicit `false` whenever the stream already
   carries a `prUrl`: never auto-create when the PR exists. Fresh/flip-cloud
   dispatches (no `prUrl`) keep `true`; address dispatches *and any retry of an
   address stream* get `false`. The rest is landed `#180` threading
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
- Run status: legality is defined negatively — `address` is refused only when
  the run is sticky-terminal (`done|failed|cancelled`, the `isStickyTerminal`
  set). That admits `running`, `awaiting_judgment`, **and `blocked_on_merges`**
  — the derived status a run presents when every stream is `landed` and nothing
  is in flight, which is precisely the post-land review-fix moment on a typical
  single-stream cloud run. (A `done` run with a still-`landed` stream cannot
  exist — exit evaluation requires streams terminal — so no carve-out is
  needed.)

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
code + message), one per condition: `no-pr` (stream has no `prUrl`/`branch`),
`pr-not-open` (merged/closed), `not-landed` (stream status outside `landed`),
`not-cloud` (local/rooms runtime — see *Runtime scope*), `run-not-addressable`
(cancelled/failed run), `cycle-exhausted` (cap reached — also writes the
escalation row), `findings-unreadable` (missing/empty file).

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
   `address(store, ship, gh, driverRunId, opts): Promise<DriverRun>` — both
   ports: `ship` because it dispatches, `gh` because the `pr-not-open` refusal
   needs live PR state (`viewPullRequest`), which the store does not hold.
2. The dispatch input is a *synthesized address doc* (preamble + findings file
   content, written beside the run's driver state), passed as `docPath` — the
   original spec docPath is *not* re-sent (the agent is fixing review findings,
   not re-implementing the spec), and `buildShipInput` keeps its existing
   docPath-in/ShipInput-out shape. `StreamAttempt.docPath` records the
   synthesized doc.
3. **The `#177` poll-boundary flip skips address re-dispatches.**
   `handleSucceededPoll` calls `flipCloudDraftReady` whenever a succeeded cloud
   result carries a `prUrl`. `markReady` in the gh-port is already idempotent —
   it checks `fetchPrReadiness().isDraft` first and early-returns on a
   non-draft — so this is not a failure mode; the mechanism rule is still worth
   one line: flip only when this dispatch *created* the PR (skip when the
   stream row already carried a `prUrl` before the poll). It saves the
   pointless readiness round-trip on every address poll and keeps the flip's
   meaning precise — it belongs to PR creation, not to every succeeded cloud
   poll.
4. **`reviewCycles` is a new counter, distinct from the existing `cycles`
   column.** `driver_streams.cycles` (0005) is the *seat-reported* count written
   at merge time via `land --cycles` / `mark-merged --cycles` — how many
   `/review-coordinator` passes the seat ran. `reviewCycles` (0014) is
   *engine-incremented*, once per `address` dispatch. They can legitimately
   disagree (a seat may run more coordinator passes than address re-dispatches);
   the cap enforces `reviewCycles` only. Do not conflate them, and do not wire
   `AddressOpts.maxCycles`'s default to `REQUIRED_REVIEW_COORDINATOR_CYCLES`
   (`types.ts`) — same value 3, different semantic scope (merge-gate evidence
   vs re-dispatch budget).
5. **The claude cloud provider needs the same no-new-PR treatment.**
   `autoCreatePR` only governs the cursor cloud runner. For
   `provider: "claude"` cloud streams, `buildShipInput` sets
   `cloud.repos[0].prBranch`, and the claude runner's cloud prompt turns a
   `prBranch` into delivery instructions that include opening a PR. The same
   stream-has-`prUrl` predicate therefore conditions that instruction block:
   when the PR exists, the prompt instructs pushing to the existing branch and
   explicitly not opening a PR. One prompt-assembly branch in the claude
   runner's cloud path — mechanism, not policy; without it, claude-provider
   address runs would try to open a duplicate PR.
6. No MCP surface in this PR — `driver_address` parity rides
   `ccp-mcp-verb-parity` (Phase 2), keeping this PR inside the sizing band.
7. Migration number `0014` (0011 is skipped in-tree; 0012 continuation and 0013
   escalations are landed).

## Validation

- Unit (`engine.test.ts`): address on a `landed` cloud stream → dispatch input
  carries `startingRef == stream.branch`, `workOnCurrentBranch: true`,
  `cloud.autoCreatePR === false` (explicit false, never omitted — the runner
  defaults omission to `true`), findings block present; `reviewCycles`
  increments exactly once per call; the stream row persists
  `workOnCurrentBranch: true`; a subsequent tick/`decide retry` re-dispatch of
  that stream resolves `startingRef == branch` + `autoCreatePR === false` from
  the row alone AND dispatches the *latest attempt's* recorded docPath (the
  synthesized findings doc), not `stream.specPath`; address is accepted on a
  run presenting `blocked_on_merges` (all streams `landed`) and refused only on
  sticky-terminal runs; a `provider: "claude"` address dispatch carries the
  push-to-existing-branch delivery instructions and no open-a-PR instruction;
  `handleSucceededPoll` skips the draft→ready flip when the stream carried a
  `prUrl` before the poll; refusal matrix (`no-pr`, `pr-not-open`,
  `not-landed`, `not-cloud`, `findings-unreadable`) each return the structured
  code and leave the stream row untouched; call at `maxCycles` → refusal +
  `cycle-exhausted` escalation row written once (dedup on the open row).
- Store: migration 0014 round-trips `reviewCycles` (defaults 0 for existing
  rows); counter survives a store reopen.
- L2 scenario: `landed` → address → `dispatched` → poll terminal-succeeded →
  `landed` again with `reviewCycles == 1` and the same `prUrl`.
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
  the cap counts *review* cycles, not infra retries — and the retry stays on
  the PR branch because the continuation is persisted on the stream row (see
  Functional step 3). Noted here so it isn't re-litigated as a bug.

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
2. The dispatch-path groundwork, all stream-state predicates independent of the
   new verb, landing first so retries and polls behave before address exists:
   the `buildShipInput` lift (`autoCreatePR: false` when the stream carries a
   `prUrl`), the claude-runner prompt branch (PR exists → push-to-branch
   instructions, no open-a-PR), the `handleSucceededPoll` flip-skip (stream had
   `prUrl` before the poll), the `dispatchStream` optional `docPath` override,
   and latest-attempt docPath resolution on the tick path.
3. `address()` in the engine: validation (via `gh.viewPullRequest` +
   `prNumberFromUrl`) → synthesized address doc → persist
   `workOnCurrentBranch: true` → continuation dispatch with the docPath
   override → cycle bump; refusal taxonomy in `types.ts`; `cycle-exhausted`
   escalation wiring.
4. `service.ts` factory method + CLI verb (`driver.ts`), mirroring `land`'s
   registration; JSON output via the existing formatter.
5. Tests per *Validation*; update `docs/features/cloud-control-plane/spec.md`
   checklist row for the verb.

**Status**: ready for impl
**Owner**: @michael
**Date**: 2026-06-12
**Related**: dossier task `driver-engine-loop` (id: `tsk_01KTWZER3KNWNJN01TPJKMN92W`); locked design [docs/features/driver-extraction/spec.md](../spec.md) — §4.1, §6, §7, §8, §9 P3. Depends on P1 (#129, `405563e`) and P2 (#130, `7bac0f8`), both on main.

# @ship/driver engine — the loop as code: walker, dispatcher, poller, judgment, resume, lease

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/store/migrations/0006_driver_tick_lease.sql` (~10), tick-lease verb on `driver-runs.ts` (~40), `packages/driver/src/ship-port.ts` (~25), `engine.ts` (~330), `judgment.ts` (~70), `service.ts` (~110), exports | ~590 | 590 |
| Tests | engine L1/L2 (fake clock + fake port), decide paths, recovery table, lease, cancel, determinism, resume | ~750 | 375 |
| Configs / docs | this doc, `package.json` dep edge | — | 0 |
| **Total** | | | **~965 — stretch band** |

**No-split justification (required > 700):** the tick is one coupled state machine — the walker decides what the dispatcher does, the poller's terminal handling is what produces judgment requests, and resume IS re-entering the same tick from persisted state. Shipping walker+dispatcher+poller without judgment/resume would ship an engine that can neither pause correctly (§7.2's drain-before-pause spans both halves) nor recover, and §11's mechanical acceptance (failed-retry, store-only resume) is unsatisfiable by either half alone. **Fallback seam if review forces a split:** PR-1 walker + dispatcher + poller with progress-only exits; PR-2 judgment + decide + §7.3 recovery + lease + cancel. Take it only if the band genuinely busts past ~1000; note the cut in the PR body.

## Goal

P1 typed the input; P2 made the store the source of truth. This phase removes the LLM from the loop itself: dep-ordered batch walking, dispatch, terminal-polling, failure routing, and resume become tested code with **zero model calls inside** — the only LLM touchpoints are judgment *exits* (spec NFR row 1). The engine ends at "streams landed, PRs known" (§4.3); reviews and merges stay policy.

## Architecture constraints

- **Dependency direction:** `@ship/driver → @ship/core → @ship/store`. The engine may import `@ship/core` types/factories and `@ship/store` verbs. It must NOT import `@ship/cli`, `@ship/mcp-server`, or `@ship/cursor-runner`, and must NOT construct its own runners or db connections — both are injected.
- **Zero model calls.** No SDK, no prompts, no LLM imports anywhere in the package. Failure *handling* is data; failure *triage* is the brain's.
- **All state transitions transactional** via the P2 store verbs; every transition bumps `driver_runs.updated_at` (already the verbs' behavior).
- **Engine errors ≠ stream failures** (§8): store/contention/precondition errors throw typed errors and change nothing; stream failures are rows + judgment requests.

## Engineering decisions

- **ED-1 — narrow ship port, not ShipService.** `ship-port.ts` defines the engine's view: `interface DriverShipPort { startShip; getRun; listRuns; cancelRun }` with the exact `@ship/core` signatures (`ShipInput → ShipStartOutput`, `GetWorkflowRunOutput | null`, `ListRunsFilter → WorkflowRun[]`). `ShipService` satisfies it structurally; tests use an in-memory fake. `isTerminal` comes from `@ship/workflow`.
- **ED-2 — spec_path resolution.** Stream `spec_path` values are repo-root-relative (locked by every real manifest). Repo root = nearest ancestor of the run's `manifest_path` containing `.git`. Resolution happens at dispatch; the resolved absolute `docPath` is recorded in the stream's attempt entry so §7.3 recovery matches on the same string the dispatch used.
- **ED-3 — cloud dispatch config from the manifest.** Cloud streams dispatch with `{ runtime: "cloud", cloud: { repos: [{ url: manifest.repo_url }], env: { type: "cloud" }, autoCreatePR: true, workOnCurrentBranch: false } }` (the locked operator defaults). A cloud stream in a manifest without `repo_url` is an **engine error before any dispatch** — actionable message naming the field.
- **ED-4 — local dispatch uses the worktree convention; the engine never creates workspaces.** Local streams require `branch_name` and dispatch with `workdir = <repo-root>/.claude/worktrees/<branch_name>/`. Pre-flight (before ANY dispatch in the tick): every local stream that could dispatch this tick must have its worktree directory present — otherwise an engine error listing each missing path and the `/worktree-add <branch>` command that creates it. Workspace creation is policy (the skill's job); the engine fails fast and clean.
- **ED-5 — tick lease via migration 0006**, two nullable TEXT columns on `driver_runs`: `tick_started_at`, `tick_ended_at`. Not a distributed lock — same trust level as the rest of the local workbench (§8 v2).
- **ED-6 — `startShip` throwing is stream data, not an engine error.** A dispatch-time throw marks that stream `failed` (attempt recorded with the error message) and the tick continues; the brain triages it like any failure. Only pre-dispatch precondition violations (ED-3/ED-4) and store errors are engine errors.
- **ED-7 — §7.3 recovery filters client-side.** `listRuns({ repo, limit: 200 })`, then filter `createdAt >= the stream's dispatching timestamp` AND `docPath === the recorded resolved docPath` AND (`branch === stream.branch_name` when the stream has one — local; cloud branches are cursor-chosen post-dispatch, so cloud matching is docPath + window only). Exactly one → adopt. Zero → revert to `pending`. More than one, or the result set is at the limit (pagination-suspect) → `dispatch-ambiguity`, never guess. *(Verifies §7.3's pre-P3 step: `WorkflowRun` rows carry `docPath` and `createdAt` today; if either is missing in practice, add the store filter first and say so in the PR.)*

## Public surface (`service.ts` — spec §6 verbatim)

```ts
export interface DriverService {
  importManifest(manifestPath: string): ImportManifestResult;        // P2, re-exposed
  run(ref: DriverRunRef, opts?: RunOpts): Promise<DriverTickResult>;
  decide(driverRunId: string, streamId: string, decision: Decision): DriverRun;
  markMerged(driverRunId: string, streamId: string, facts: MergeFacts): DriverRun;
  cancel(driverRunId: string): DriverRun;                            // run-level (§8 v2)
  render(driverRunId: string): string;                               // P2, re-exposed
  getDriverRun(id: string): DriverRun | null;
  listDriverRuns(filter?: { repo?: string; status?: DriverRunStatus[]; limit?: number }): DriverRun[];
}

export type DriverRunRef = { driverRunId: string } | { manifestPath: string }; // path → auto-import
export interface RunOpts {
  batch?: number;
  maxWaitMs?: number;              // default 20 min
  pollIntervalMs?: number;         // default 30 s
  maxParallel?: { local?: number; cloud?: number }; // defaults: local 1 (§7.5), cloud 4
  force?: boolean;                 // lease takeover (§8)
}
export type Decision =
  | { kind: "retry" }
  | { kind: "skip"; reason: string }
  | { kind: "abort"; reason: string }
  | { kind: "adopt"; workflowRunId: string };
export interface MergeFacts { prNumber: number; mergeCommit: string; mergedAt?: string; cycles?: number }
```

`DriverTickResult` and `JudgmentRequest` exactly as spec §6 (statuses `running | awaiting_judgment | blocked_on_merges | done | failed | cancelled`; `awaiting` non-empty iff `awaiting_judgment`; `unmerged` non-empty iff `blocked_on_merges`; compact `streams` views; `progress` counts). Reserved judgment kinds (`merge-confirmation`, `review-adjudication`) stay reserved — type them, don't emit them.

Construction: `createDriverService({ store, ship, clock?, rng? })` — store is `@ship/store`'s `Store`, ship is a `DriverShipPort`, clock/rng injectable for tests (jitter via `rng`; defaults `Date.now`-based ISO clock / `Math.random`).

## The tick (`engine.ts` — §4.1, §7)

Ordered; every numbered transition is a store txn; `tick_ended_at` is stamped on **every** exit path including throws (try/finally).

1. **Resolve** the ref: `manifestPath` → `importManifest` (idempotent — re-running on an imported manifest resumes it).
2. **Lease (§8):** live = `tick_started_at` set AND (`tick_ended_at` null OR `< tick_started_at`) AND `updated_at >= now − 3 × pollIntervalMs`. Live and not `force` → typed `TickLiveError` (engine error). Otherwise stamp `tick_started_at`.
3. **Sticky terminal guard:** run status `done | failed | cancelled` → return that state immediately, no work.
4. **Recovery pass (§7.3 / ED-7)** for every stream stuck `dispatching`: adopt / revert / emit `dispatch-ambiguity`. Ambiguities pause the run (`awaiting_judgment`) at step 7's evaluation — recovery never guesses and never dispatches.
5. **Pre-flight (ED-3/ED-4):** validate cloud `repo_url` and local worktree presence for every stream that could dispatch this tick. Violations → typed engine error before any dispatch.
6. **Walk + dispatch + poll loop**, bounded by `maxWaitMs`:
   - **Eligibility (§7.6):** a batch is dispatch-eligible iff every batch in its `depends_on` has all streams `done | skipped` (merged-or-skipped — `landed` does NOT satisfy a dep). Batches with no deps are always eligible. `opts.batch` restricts the walk to that batch (its deps still gate it).
   - **Dispatch** `pending` streams of eligible batches up to `maxParallel` caps (local default 1 — friction 2026-06-02; cloud default 4): txn → `dispatching` + attempt `{ dispatchedAt, docPath }` → `port.startShip(...)` → txn → `workflow_run_id` + `dispatched`. A `startShip` throw → ED-6.
   - **Poll** every `pollIntervalMs` (jittered ±20% via `rng`): `port.getRun` each `dispatched`; on `isTerminal`: `succeeded` → harvest landing facts (`branches[0].prUrl` → `pr_url`, branch name → `branch` if the stream had none) → `landed`; `failed`/`cancelled` → attempt marked terminal with `failureCategory` carried through → `failed`. **The run does not pause while siblings are in flight (§7.2)** — failed streams wait until nothing is `dispatching | dispatched`.
   - Re-evaluate dispatch after every poll scan (serialization slots free up; skips can complete batches).
7. **Exit evaluation** (first match wins):
   - any `failed` stream (or pending ambiguity) AND nothing `dispatching | dispatched` → run `awaiting_judgment`; result `awaiting: [failure-triage per failed stream, dispatch-ambiguity per unresolved recovery]`.
   - every stream of every batch `done | skipped` → run `done`.
   - work remains but every dispatchable batch is gated only by landed-but-unmerged dep streams → result `blocked_on_merges` with the `unmerged` views (run status stays `running`).
   - `maxWaitMs` expired → result `progress` (run status `running`).

**`decide`:** gated on run `awaiting_judgment`; `retry` → stream `pending` (attempts history kept; §4.5 same branch, fresh `wf_` on next tick), run → `running`; `skip` → stream `skipped` (reason into `error_message`), run → `running`; `abort` → run `failed`, sticky; `adopt` → answers `dispatch-ambiguity`: stream `dispatched` with the chosen `workflow_run_id`. Anything else (wrong run state, stream not awaiting) → typed error.

**`markMerged`:** stream → `done` + `pr_number`/`merge_commit`/`merged_at` (+ optional `cycles`, §10d). The skill calls this after its review/merge policy; it's how deps unblock.

**`cancel` (§8 v2):** `port.cancelRun` every `dispatching | dispatched` stream's run (idempotent; a cancel-call failure on one run doesn't abort the sweep — record and continue), those streams → `failed` with a cancelled attempt, run → `cancelled`, sticky.

## Determinism

Same manifest + same store state → identical dispatch plan and identical `DriverTickResult` shape (two-run test with a frozen fake port). Jitter affects timing only, never the plan; `rng` is injected so tests pin it.

## Acceptance

- Golden-manifest walk: multi-batch fixture drives dispatch in dep order; failed-retry path (fail → judgment exit 10-shape → decide retry → re-dispatch same branch, fresh run id, attempts length 2); `batch` targeting.
- Two-run plan determinism.
- Store-only resume: kill the tick (simulated: new service instance over the same db) at each persisted state — `dispatching` (→ recovery), `dispatched` (→ re-poll), `failed` (→ judgment) — and the manifest file deleted; the run proceeds from rows alone.
- §7.3 recovery table: zero / exactly-one / multiple candidates / at-limit ⇒ pending / adopt / ambiguity / ambiguity.
- §7.6: a no-dep batch dispatches while a dep-gated sibling waits on unmerged landed streams; `blocked_on_merges` lists exactly the unmerged ones; `markMerged` unblocks.
- Lease: live-tick refusal, stale takeover, `force`, ended-tick never blocks.
- `cancel` idempotent incl. partial cancelRun failures.
- Zero model calls (no LLM/SDK imports in `packages/driver`); dep direction enforced (no cli/mcp-server/cursor-runner imports).
- Coverage thresholds met; mutation score not reduced; `make check` green ubuntu + windows.

## Test plan

L1/L2 in `packages/driver` with fake clock, seeded rng, in-memory store, and a scripted fake `DriverShipPort` (programmable per-run outcomes + recorded calls): eligibility matrix, mixed-runtime caps (cloud fan-out while local serializes), poll-to-terminal transitions, §7.2 drain ordering, all four decide paths + gating errors, recovery table, lease matrix, cancel sweep, determinism, resume-from-each-state. Store-side: 0006 migration applies on 0005; lease verb bumps.

## Out of scope

- CLI / MCP surfaces (P4) — nothing in `@ship/cli` or `@ship/mcp*` changes in this PR.
- Review-cycle automation, merge execution (F3/F4 — `merge-confirmation` stays a reserved type).
- `ship driver watch` (F6), push events (F5 — poll sites stay isolated in `awaitTerminal` per §8 so F5 can replace them), MA runtime.
- Worktree creation (policy; ED-4 fails fast instead).
- `SHIP_TEST_FAKE_CURSOR` e2e (P4 — the engine sees it only through the injected real ShipService there).

## Implementation plan

1. Migration 0006 + tick-lease verb + store tests.
2. `ship-port.ts` + fake port test harness.
3. `engine.ts`: eligibility → dispatch → poll → exit evaluation (progress/done paths first).
4. `judgment.ts` + decide + §7.3 recovery + lease + cancel + markMerged.
5. Determinism + resume + full test matrix; exports; `make check` clean.

Single PR (stretch band, justified above). Title: `feat(driver): engine tick loop — walker, dispatcher, poller, judgment, resume (P3)`. Include this doc verbatim at `docs/features/driver-extraction/phases/driver-engine-loop.md`.

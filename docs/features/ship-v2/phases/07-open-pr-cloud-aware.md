# Phase 07 — `open_pr` cloud-aware

Status: design draft
Owner: ship (cursor)
Date: 2026-05-22

> Predecessor: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md) (introduced the cloud runtime) + [02-open-pr.md](02-open-pr.md) (introduced `open_pr`). Trigger: [cursor-cloud-followups.md § A](../cursor-cloud-followups.md) — the natural successor to phase 06.

## Scope

**Weighted LOC budget — ~620, "ideal" band in 1 PR (split into 2 if over 700).**

Files this phase touches:

- `packages/store/migrations/0002_cursor_runs_branches.sql` (NEW) — adds `cursor_runs.branches_json TEXT NULL`.
- `packages/store/src/cursor-runs.ts` — persist + hydrate `branches`; extend `RecordCursorRunInput` + `UpdateCursorRunInput`.
- `packages/workflow/src/cursor-run-ref.ts` (or wherever the schema lives) — `CursorRunRef.branches` optional field with `branchSchema`.
- `packages/core/src/service.ts` — `tryWriteSuccessArtifacts` (or the cursor-run finalize path) persists `result.branches` into the new column.
- `packages/core/src/open-pr.ts` — `resolveHead` becomes runtime-aware via a `resolveCloudHead` delegate; cloud path skips `pushBranch` and `listCommitSubjects`.
- `packages/core/src/errors.ts` — new `CloudBranchUnresolvedError`.
- `packages/core/src/open-pr.test.ts` — cloud-row hydration paths.
- `e2e/scenarios/cloud-explicit-open-pr.e2e.test.ts` (NEW) — live cloud + explicit-open-pr L3 scenario.
- Test churn: ~10 references across `packages/store/`, `packages/core/`.

## Summary

Phase 04 shipped the cloud runtime. Phase 06 fixed its first-real-invocation bugs. The current gap: `ship.open_pr` only works on local runs. For cloud runs the branch lives only on the remote (cursor's VM pushed it; the local workdir doesn't have it), so `resolveHead`'s local-branch-or-`git rev-parse` lookup returns nothing useful and `pushBranch` would either no-op or error.

This phase closes the loop. Cursor's cloud `RunResult.git.branches` (typed today as `{repoUrl, branch?, prUrl?}[]`) already arrives at `CursorRunResult.branches` — we just don't persist it anywhere queryable. The phase adds a single column to `cursor_runs`, makes `open_pr.resolveHead` runtime-aware, and skips the now-irrelevant local-only steps when the underlying cursor_run was cloud.

Net effect: the operator can run `mcp__ship__ship --runtime cloud --cloud-repo X --cloud-auto-create-pr false` to get cursor to produce the branch on the remote without opening the PR, then `mcp__ship__open_pr { workflowRunId }` to open the PR after a manual QA pass. This restores runtime symmetry — every flow that works for local now works for cloud.

## Functional requirements

### F1 — Persist `cursor_runs.branches_json`

A new migration `0002_cursor_runs_branches.sql` adds `branches_json TEXT NULL` to `cursor_runs`. `cursor-runs.ts` writes the JSON-serialized `branches` array on terminal-status update; reads it on hydration into `CursorRunRef.branches`.

- Local runs persist NULL (current branches array is empty `[]` — no point round-tripping a zero-value).
- Cloud runs persist a non-empty array.
- Schema hydration: `null` column → `branches: []`; non-null column → parsed array, validated by Zod.

Acceptance: on a cloud workflow_run, `store.getCursorRun(cursorRunId)` returns `branches: [{ repoUrl, branch, prUrl? }]`. On a local workflow_run, returns `branches: []`.

### F2 — `open_pr.resolveHead` runtime-aware

`open_pr.resolvePrep` (where `resolveHead` is called today) reads the implement-phase's cursor_run via the existing `run.cursorRuns` shape (already on the hydrated `WorkflowRun`). If `cursorRun.runtime === "cloud"`:

- Use `cursorRun.branches[0].branch` as head. Error with new `CloudBranchUnresolvedError` if `branches` is empty or `branches[0].branch` is undefined / empty.
- Skip `pushBranch` — cursor cloud already pushed the branch to origin.
- Skip `listCommitSubjects` — the branch isn't in the local workdir.
- PR body falls back to `input.body` (if provided) or a minimal `"Open PR for cloud run <workflowRunId>"` summary referencing `docPath`.

If `cursorRun.runtime === "local"`: current behavior preserved verbatim.

The branching lives behind a `resolveHead` delegate refactor rather than an inline `if (runtime === "cloud")` switch inside `resolvePrep` (per ED-3 below).

Acceptance: `mcp__ship__open_pr { workflowRunId }` against a cloud workflow_run with `autoCreatePR: false` opens a PR pointing at the cloud-pushed branch. The returned `OpenPrOutput.head` matches `cursorRun.branches[0].branch`.

### F3 — Idempotency unchanged for cloud

`probeExistingPr` already lists open PRs for a `(head, base)` via gh's API. For cloud runs where `autoCreatePR: true` was set (cursor itself opened the PR), open_pr discovers it via the existing-PR probe → `alreadyExisted: true` → no double-open. No new code needed for this — the probe already does the right thing once F2's head resolution is correct.

Acceptance: `open_pr` against an `autoCreatePR: true` cloud run returns `{ alreadyExisted: true, prNumber, prUrl }` matching the PR cursor opened, with `head` set from `cursorRun.branches[0].branch`.

### F4 — L3 cloud regression-guard scenario

New `e2e/scenarios/cloud-explicit-open-pr.e2e.test.ts` (gated on `SHIP_LIVE === "1" && SHIP_CLOUD === "1"` matching the existing cloud L3 pattern):

1. Fires `ship.ship --runtime cloud --cloud-repo $SHIP_CLOUD_SANDBOX --cloud-auto-create-pr false` against the live sandbox.
2. Awaits terminal `succeeded`.
3. Reads the persisted `cursor_runs.branches` via the store API; asserts non-empty + `branches[0].branch` defined.
4. Fires `mcp__ship__open_pr { workflowRunId }`.
5. Asserts: `OpenPrOutput.head` matches `cursorRun.branches[0].branch`; `prUrl` is set; gh API confirms the PR exists.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Persistence layer | **New `branches_json` column on `cursor_runs`** | Read `result.json` off disk in open_pr at call time | Column survives artifact-dir cleanup; queryable via store API; single source of truth; matches how `model_json` and other cursor-run-scoped state already lives on this table. |
| PR body for cloud | **Fall back to docPath summary or `input.body`** | Fetch remote commits via gh's API to build a Changes list | Avoids a new gh API path + round-trip; the doc summary IS what triggered the run; operators who want commit-level detail can pass `input.body` explicitly. |
| Migration shape | **NULL by default, no `DEFAULT '[]'`** | `DEFAULT '[]'` so pre-migration rows look indistinguishable from local | Three-state vs two-state: NULL = pre-migration *or* not-yet-populated; `[]` = explicit local empty. Cleaner forensic signal. Hydration treats both as `branches: []`. |
| Refactor shape | **`resolveHead` delegate per runtime** | Inline `if (runtime === "cloud") {...}` in `resolvePrep` | Keeps each path testable in isolation; mirrors the V2 cursor-runner runtime-dispatch pattern (Local vs Cloud runner classes). |
| Push / list-commits gating | **Skip both entirely when cloud** | Best-effort `git fetch origin <branch>` then push/list locally | Adds a remote round-trip + a new failure mode (fetch errors) for marginal value; the cloud branch is already complete-on-remote. |

## Engineering decisions

### ED-1 — Branches live on `cursor_runs`, not `workflow_runs`

The branches are the output of the cursor agent run, not the workflow envelope. Storing them on `cursor_runs` preserves the V1 phase model (cursor_run = SDK invocation; phase = workflow step; workflow_run = run envelope). `open_pr` already accesses `run.cursorRuns[*]` for the implement-phase cursor_run, so the read path is natural and no new join is needed.

### ED-2 — Schema migration, no breaking type change

`CursorRunRef.branches` is a NEW field. Optional in the schema with `.default([])` so callers that don't read it are unaffected; pre-migration rows hydrate with `branches: []`. The Zod shape is `z.array(branchSchema).default([])` where `branchSchema = z.object({ repoUrl, branch: z.string().optional(), prUrl: z.string().optional() })`.

### ED-3 — Resolver delegate per runtime, not a runtime switch

`resolveHead` doesn't grow an `if (runtime === "cloud") ... else ...` block. Instead the two paths are separate functions — `resolveLocalHead(worktree, git)` and `resolveCloudHead(cursorRun)` — and `resolvePrep` picks one based on `cursorRun.runtime`. Each path is testable in isolation; the switch lives at one well-named call site.

### ED-4 — `open_pr` reads `cursorRun` once at prep time, no re-read mid-run

The hydrated `run.cursorRuns[implementCursorRun]` is captured in the `PreparedOpenPr` struct before `driveOpenPrPhase` starts. The runtime field is plain (just a string discriminant) so no recovery for staleness is needed.

## Validation plan

- **Unit (store)** — `packages/store/src/cursor-runs.test.ts` gets:
  - Record + hydrate round-trip for `branches: [{ repoUrl, branch, prUrl }]`.
  - Hydrate of pre-migration row (manually inserted with `branches_json IS NULL`) returns `branches: []`.
  - `updateStatus` with `branches` patch persists JSON; hydration round-trips.

- **Unit (open_pr)** — `packages/core/src/open-pr.test.ts` gets:
  - Local cursor_run → existing behavior unchanged (same fixtures already used today).
  - Cloud cursor_run with `branches[0].branch === "feature/x"` → `head` resolves to `"feature/x"`; `gh.createPr` is called; `git.pushBranch` and `git.listCommitSubjects` are NOT called.
  - Cloud cursor_run with empty `branches` → throws `CloudBranchUnresolvedError`.
  - Cloud cursor_run + existing PR matching `(head, base)` → `alreadyExisted: true`, no createPr call.

- **L2 scenario** — `packages/test-harness/scenarios/cloud-explicit-open-pr.scenario.test.ts` against `FakeCursorRunner` configured to populate `branches`. Asserts the full ShipService + OpenPrService composition.

- **L3 (gated)** — `e2e/scenarios/cloud-explicit-open-pr.e2e.test.ts` per F4.

- **`make check`** and `pnpm run coverage` both green; coverage on `open-pr.ts` doesn't regress.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Migration applied to a live store breaks existing reads | Pre-existing cursor_runs hydrate-fail | New column is `NULL`-by-default with no `DEFAULT '[]'`; hydration treats NULL as `branches: []`. Migration is purely additive. Tested via the "pre-migration row" unit case. |
| `cursor_runs.branches_json` JSON malformed (manual DB edit, partial write) | `parseCursorRun` throws | Existing `StoreSchemaError` wrapping pattern already catches malformed JSON on `model_json`; same pattern extends to `branches_json`. Surfaces the row id so the operator can repair. |
| Cursor cloud reports `branch.prUrl` for a closed/deleted PR | open_pr's idempotency probe wouldn't detect it (probe lists OPEN PRs) | Probe falls through to `createPr` → reopens the work. Self-healing. The edge case (cursor reporting a stale `prUrl`) is rare and not worth a special branch. |
| `workOnCurrentBranch: true` cloud runs surface no new `branches[0].branch` | `CloudBranchUnresolvedError` fires | Out of scope (see § Out of scope) — that mode's PR-shape isn't designed for this flow. Error message points the operator at the follow-up. |
| Cloud run finished but `branches_json` write failed (artifact-write failure) | open_pr can't resolve head | The existing `ArtifactWriteFailedError` path in `finalizeSuccess` already routes a failed write to the run's failure path → the workflow_run is `failed`, the precondition check in open_pr (`assertImplementPhaseSucceeded`) refuses. Net: no half-state. |

## Out of scope

- Multi-repo cloud runs — phase 04's single-element `repos` tuple still holds; `branches_json` schema admits an N-element array but `open_pr` uses `branches[0]` only.
- `Agent.resume` cross-process — separate phase 08 candidate; doesn't affect the open_pr surface.
- `workOnCurrentBranch === true` cloud runs through open_pr — that mode's workflowRun-as-one-new-branch shape doesn't fit. Filed as a follow-up after this phase merges.
- Surfacing `branches` via `get_workflow_run` MCP tool / CLI output — schema change to that surface is a separate, small follow-up (operator can read via the store API today).
- Changing `open_pr`'s behavior for local runs — strict no-op for the local path; every existing test passes verbatim.

## Implementation plan

One PR (target: amazing-to-ideal band). Step list = commit boundaries; split if budget exceeds 700.

1. **Migration + store ops.** Write `0002_cursor_runs_branches.sql`; extend `cursor-runs.ts` (`RecordCursorRunInput.branches`, `UpdateCursorRunInput.branches`, hydration), `CursorRunRef.branches` Zod schema, `cursor-runs.test.ts` cases. **Validation:** unit suite for store green.

2. **Service finalize path.** `tryWriteSuccessArtifacts` (or the equivalent cursor-run finalize hook) calls `cursorRuns.updateStatus` with `branches: result.branches`. Tests in `service.test.ts`. **Validation:** scenario-level test against `FakeCursorRunner` shows branches round-trip from runner → store.

3. **`open_pr` runtime-aware.** Add `CloudBranchUnresolvedError` to `errors.ts`. Refactor `resolveHead` into `resolveLocalHead` + `resolveCloudHead`. Gate `pushBranch` and `listCommitSubjects` on `cursorRun.runtime`. Add `open-pr.test.ts` cases per § Validation. **Validation:** unit suite green; existing local tests untouched.

4. **L3 scenario.** Write `e2e/scenarios/cloud-explicit-open-pr.e2e.test.ts` per F4. **Validation:** `SHIP_LIVE=1 SHIP_CLOUD=1 pnpm -F @ship/e2e test` passes; the scenario is gated to no-op when env vars are unset.

## Cross-refs

- Predecessor: [phase 04](04-cursor-cloud-runner.md) — introduced `CloudCursorRunner` and `result.branches` end-to-end.
- Predecessor: [phase 02](02-open-pr.md) — introduced `OpenPrService` + `mcp__ship__open_pr`.
- Predecessor: [phase 06](06-cloud-fix-arc.md) — fixed cloud-runtime bugs that would have prevented this phase from being testable.
- Backlog source: [cursor-cloud-followups.md § A](../cursor-cloud-followups.md#a--open_pr-cloud-aware-already-filed-as-phase-04s-natural-successor).
- Memory: `feedback_environment_agnostic.md` — runtime symmetry is the V1 posture; this phase restores it for `open_pr`.
- Memory: `feedback_pr_sizing.md` — ideal band, one PR; split if step 4 + step 3 jointly trip the 700 budget.

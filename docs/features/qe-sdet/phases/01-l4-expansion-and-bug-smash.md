# Phase 01 — L4 expansion + `open_pr` bug-smash

Status: design draft, revision 0 (2026-05-16). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-16

> **Companion docs.** [../spec.md](../spec.md) defines the test-layer taxonomy + philosophy this phase operates inside. Predecessors: [ship-v1/phases/04-qe-sdet.md](../../ship-v1/phases/04-qe-sdet.md) (test-harness + 4-layer skeleton) and [ship-v1/phases/09-bug-smash.md](../../ship-v1/phases/09-bug-smash.md) (hostile-reviewer pass; methodology re-used here for Track B). The surface under bug-smash is [ship-v2/phases/02-open-pr.md](../../ship-v2/phases/02-open-pr.md). The PR-sizing rule in [CLAUDE.md](../../../../CLAUDE.md) governs the budgets below.

## Scope

**Weighted-LOC budget:**

| Track | Weight | Estimate |
|---|---|---|
| Track A — L4 expansion (test files + 1 new fixture tree + 0 src) | 0.5× × ~500 LOC = 250 | new `*.e2e.test.ts` files + `e2e/fixtures/open-pr-sandbox/` |
| Track B — bug-smash (chips, no code) | 0× | per phase 9 model |
| **Total weighted** | | **~250 LOC** |

Comfortably under the < 500 "amazing" band. The doc PR itself is 0× (docs).

Track B produces chips. Each chip materializes as its own task doc + PR with its own LOC budget and review cycle. Phase 9's 8-cap on the P2/P3 chip queue applies.

**Time budget:** Track A ~3–4h once design lands; Track B ~1 session (mirroring phase 9's pacing).

## Summary

Phase 4 stood up the L4 skeleton with one scenario (hello-world ship). Phase 9 ran the bug-smash methodology against the existing surfaces and closed with zero P0/P1 + 5 P2/P3 chips. Since then, the async-ship phase and the `open_pr` phase have landed on main without a parallel QE pass.

This phase closes two gaps:

- **Track A — L4 expansion.** Build out the live-e2e suite from one scenario to cover the `open_pr` surface end-to-end against real Cursor + real GitHub. New scenarios: live `open_pr` against a sandbox repo; `ship → open_pr` chain; live cancellation; failure paths (missing token, malformed doc, push reject); idempotent re-open. Each gets its own `*.e2e.test.ts` file under `e2e/scenarios/`, gated on `SHIP_LIVE=1`.
- **Track B — bug-smash.** Re-run phase 9's L1 (hostile code-read) + L2 (adversarial input matrix) + L3 (live dogfood) layers against the `open_pr` surface. Output is chips with reproducers, not code in this phase's branch. Follows phase 9's ED-1 validation bar (reproducer-or-precise-codepath) and ED-2 chip-prompt checklist verbatim.

Track A and Track B are bundled into one phase doc because they share a goal (validate the `open_pr` surface) and a session (the operator's `CURSOR_API_KEY` + `GITHUB_TOKEN` load + the sandbox-repo setup are needed for both). Their PR outputs differ (Track A is one impl PR; Track B is N chips → N PRs), which is fine — the phase doc declares the dependency, not the PR shape.

## Functional requirements

### F1 — Track A: L4 scenarios (live e2e)

Each scenario is a single file under `e2e/scenarios/` and inherits the `SHIP_LIVE=1` gate from `e2e/vitest.e2e.config.ts`. Files mirror the existing `hello-world.e2e.test.ts` pattern: spawn the CLI binary with `tsx` against an isolated tmp tree, assert post-conditions, clean up.

**A1 — `open-pr.e2e.test.ts` — live `open_pr` against a sandbox repo.**

1. Copy `e2e/fixtures/open-pr-sandbox/` into a tmpdir.
2. `cd` into the tmp tree; `git init`; commit the initial state; `git remote add origin git@github.com:<sandbox>.git`.
3. `ship` against `docs/features/sandbox.md` to produce a workflow run with a real branch.
4. `ship open_pr <workflowRunId> --json`.
5. Assert: exit 0; `prUrl` is a real GitHub URL; `gh pr view <prNumber> --json state,headRefName,baseRefName` confirms PR open, head matches the run's branch, base is the sandbox's default branch; phase row `Phase{kind: "open_pr", status: "succeeded"}` written to the run's SQLite store.

Sandbox repo: a dedicated throwaway GitHub repo (e.g. `itsHabib/ship-live-sandbox`). Owned by the operator; accepts force-push from `GITHUB_TOKEN`. Each scenario run pushes a fresh branch named `tower/live-e2e-<workflowRunId>` so concurrent runs don't collide.

Requires `GITHUB_TOKEN` in env in addition to `CURSOR_API_KEY` + `SHIP_E2E_SANDBOX_REPO`. `test.skip` when any is absent (mirroring `hello-world.e2e.test.ts`'s `HAS_KEY` pattern, broadened).

**A2 — `ship-then-open-pr.e2e.test.ts` — chained workflow.**

Drives the agent-style call sequence: `ship` (async return) → poll `get_workflow_run` until terminal → `open_pr` against the same `workflowRunId`. Asserts the full chain succeeds and the resulting PR contains the agent's committed changes (verified via `gh pr view <n> --json files`).

Exercises the async-return-then-poll path that `hello-world.e2e.test.ts` doesn't cover (the existing hello-world scenario uses the sync `ship` return that the async-ship phase changed).

**A3 — `cancel-live-ship.e2e.test.ts` — live cancellation against real SDK.**

Starts a real ship run against a fixture doc (`e2e/fixtures/open-pr-sandbox/docs/features/long.md`) designed to take ≥30s; sends `cancel_workflow_run` after `events.ndjson` shows the agent has started (~5–10s in); asserts the run reaches `cancelled` and the SDK's abort observation appears in `events.ndjson`.

Provides L4 cancellation coverage that phase 9 § F5 explicitly skipped ("The existing harness doesn't expose a 'cancel mid-run' hook").

**A4 — `open-pr-failure-paths.e2e.test.ts` — failure modes.**

Three sub-tests (each its own `test()` block) in one file:

- *Missing `GITHUB_TOKEN`*: `open_pr` fails with the typed `GhAuthError` per the open_pr phase § Risks "gh auth expired"; phase row is `failed`; no PR on the sandbox repo.
- *Malformed task doc (no H1)*: `open_pr` title derivation falls back to the branch-name path per the open_pr phase ED-5; PR is opened with the inferred title (e.g. `feat: open-pr-failure-paths-...`).
- *Push reject* (sandbox `main` has commits the local tmp tree doesn't): phase row is `failed`; typed `BranchPushFailedError` recorded in the phase's `result.json`. Setup: scenario pre-pushes a commit to a target branch via `gh api`, then attempts `open_pr` against it.

**A5 — `idempotent-open-pr.e2e.test.ts` — re-call returns the existing PR.**

Calls `open_pr` twice for the same workflow run. Asserts the second call returns `alreadyExisted: true` with the same `prUrl`. Exercises the open_pr phase § F5 against real GitHub (the unit tests mock `gh.listOpenPrsForBranch`; this scenario hits real `gh pr list`).

### F2 — Track A: fixture tree at `e2e/fixtures/open-pr-sandbox/`

New tree alongside the existing `test-repo/`. Contains:

- `README.md` — empty stub.
- `docs/features/sandbox.md` — task doc the agent ships in A1, A2, A5.
- `docs/features/long.md` — task doc designed to produce a multi-file scaffold that runs ≥30s on real Cursor; used by A3.
- `.gitignore` — minimal (excludes `node_modules`, build artifacts).

Per `../spec.md` § ED-4, L4 fixtures are co-located under `e2e/`; this phase adds one new tree, doesn't rearrange the layout.

### F3 — Track A: streaming + isolation conventions

Each new scenario reuses three conventions from `hello-world.e2e.test.ts`:

- **Isolated env via `HOME` / `APPDATA` / `USERPROFILE` overrides** so the CLI's config dir resolves inside the tmpdir, not the operator's real config.
- **Event tailer** (`startEventTailer`) for visibility during a 30–90s live run. Extract the tailer from `hello-world.e2e.test.ts:140–186` into `e2e/scenarios/event-tailer.ts` (shared helper) since 5 scenarios will use it. The existing implementation's multi-byte UTF-8 boundary handling stays — see the JSDoc on `position` for why.
- **`test.skip` on missing env vars** so the gate fails loud at the suite level, not silent at each assertion.

### F4 — Track B: bug-smash methodology

Re-uses phase 9's three layers verbatim. Surface under smash: the open_pr phase's added files — `@ship/core/src/open-pr.ts`, `@ship/core/src/gh.ts`, `@ship/core/src/git-remote.ts`, `@ship/mcp-server/src/tools/open-pr.ts`, `@ship/cli/src/commands/open-pr.ts`, plus the `@ship/workflow` enum extension. Out of scope: the async-ship phase's async `ship` return contract (no significant new surface beyond what phase 9 already smashed — only the return shape changed, not the workflow).

**L1 — Read pass.** Hostile-reviewer code-read of every file the open_pr phase added or changed. Apply phase 9's bug categories (concurrency, lifecycle, error-path holes, boundary mismatches, UX gaps) and validation bar (reproducer-or-precise-codepath).

**L2 — Adversarial input.** Drive the `open_pr` CLI binary and MCP tool with adversarial input:

- *CLI matrix:* empty `workflowRunId`, malformed id, very long `--title` / `--body` / `--base` (10kB+), `--base` with shell metachars, `--draft=banana`, repeated calls in parallel against the same workflow run (idempotency under contention), `--json` with no terminal output (pipe to `cat`).
- *MCP matrix:* call before initialize, oversize payload (1MB+ args), missing required field, extra field (strict-mode rejection), `workflowRunId` for a run with no implement-phase row, `workflowRunId` for a run whose implement phase is `failed` (expect typed error pre-row), `workflowRunId` for a run whose `workdir` isn't a git checkout, two concurrent calls on the same workflow run via the same connection (race window).

**L3 — Live dogfood.** Run the Track A scenarios 3× to flake-check. Capture any chip-worthy behavior per phase 9 § F5 checklist.

Each smash layer files chips against `mcp__ccd_session__spawn_task` with the same prompt structure as phase 9 § ED-2.

### F5 — Track B: chip queue management

The 8-cap from phase 9 applies. If the queue grows past 8 mid-smash, this phase closes and a Phase-01b doc is drafted instead. Zero findings is a valid outcome and is documented in this doc's outcome section.

## Non-functional requirements

- **No new production-side code.** This phase adds L4 test files + a fixture tree + one shared test helper (`event-tailer.ts`). All test-side.
- **No new production dependency.** Helpers stay under `e2e/scenarios/`; no new pnpm-workspace package.
- **Strict TS + lint match.** Per phase 4 § "Strict TS + lint matching the rest of the repo." The eslint relaxation for `*.test.ts` (longer functions) applies but the comment + naming rules don't change.
- **L4 quota discipline.** Each scenario burns 1+ Cursor run + 1+ GitHub PR-open per execution. Per-file JSDoc documents the cost (mirroring `hello-world.e2e.test.ts`'s "Burns one Cursor run per execution — not free").
- **Sandbox repo is operator-owned, not Ship-owned.** Ship doesn't create or destroy the sandbox repo. The repo lives at `itsHabib/ship-live-sandbox` (or operator-chosen path); env-injected via `SHIP_E2E_SANDBOX_REPO`. One-time setup documented in `e2e/README.md`.
- **No L4 by default in CI.** Default `make integration` doesn't touch L4. `make e2e` requires `SHIP_LIVE=1` + the env vars above. Matches phase 4 § F4's gating.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Sandbox repo vs. ephemeral repo per run | Single dedicated sandbox repo | `gh repo create` per run | Single repo: lower quota, simpler env wiring, faster local re-run. Ephemeral: zero shared state but adds quota + permissions ceremony. Ship's L4 isn't aiming for parallel CI yet — single repo suffices. |
| Force-push on each run | Yes (operator-owned sandbox repo) | Branch-per-run, never reuse | Force-push: predictable cleanup. Branch-per-run avoids force-push but the sandbox repo accumulates a branch graveyard. Force-push wins given the repo is throwaway. |
| Track A + Track B in one phase doc | Yes | Split into `01a-l4` and `01b-bug-smash` | Operator preference (session 2026-05-16). Shared session (key load + sandbox setup), shared goal (validate `open_pr`). PR outputs already differ (code vs. chips), which keeps the boundary clean even bundled. |
| New scenarios under `e2e/scenarios/` (flat) vs subfolder | Flat | `e2e/scenarios/open-pr/` subfolder | Flat namespace, easy `find e2e/scenarios -name '*.e2e.test.ts'`. Subfolders premature at 5 scenarios; revisit if the count grows past ~10. |
| Extract `event-tailer.ts` vs duplicate inline | Extract | Inline copy in each file | DRY at 5 use sites; one helper keeps the multi-byte UTF-8 boundary fix in one place. The shared helper is also new — covered by Track A's budget. |
| Sub-tests in `open-pr-failure-paths.e2e.test.ts` | One file, three `test()` calls | Three separate files | The three failure modes share fixture setup; bundling halves the fixture overhead. Independent within the file via `describe` blocks. |
| Quota cost in JSDoc vs README table | Per-file JSDoc | Central table in `e2e/README.md` | Per-file: the cost is visible when reading the test. Central: requires cross-reference. Per-file wins for least-surprise; `e2e/README.md` gets a one-liner pointing at the convention. |
| Smash the async-ship phase's async return | Out of scope | Include | Phase 9 covered the existing `ship` surface; the async-ship phase only changed the return shape — no new state machine, no new IO. The interesting recent delta is `open_pr`. |

## Engineering decisions

### ED-1 — Sandbox repo URL via env, default unset

Each L4 scenario reads `SHIP_E2E_SANDBOX_REPO` (e.g. `itsHabib/ship-live-sandbox`). Unset = `test.skip`. Matches phase 9's `CURSOR_API_KEY`-driven gating and keeps the suite portable: any operator with their own sandbox repo can run the suite locally.

### ED-2 — One `git remote add origin` per scenario, no persistent worktree

Each scenario's tmp tree gets its own `git init` + `git remote add origin git@github.com:<sandbox>.git`. The tmp tree is destroyed in `afterAll`. No persistent worktree across runs — keeps state clean, makes scenarios independently runnable.

### ED-3 — Branch naming: `tower/live-e2e-<workflowRunId>`

Branches pushed during L4 use `tower/live-e2e-<workflowRunId>` so they're identifiable and disposable. Operator's `feedback_chip_worktrees.md` memory establishes `tower/<name>` as the convention; this extends it with the `live-e2e-` prefix so a periodic cleanup script can filter (`gh api repos/<sandbox>/branches --jq '.[].name' | grep '^tower/live-e2e-' | xargs ...`).

### ED-4 — Track B chips reference phase 9 ED-1 + ED-2 verbatim

The validation bar (reproducer-or-precise-codepath) and the chip prompt checklist (symptom / reproducer / expected vs actual / suggested approach / out of scope) are phase 9's. This phase doesn't redefine them; it cites them. Future bug-smash phases cite the same.

### ED-5 — Failure-path scenario uses pre-existing remote state

`open-pr-failure-paths.e2e.test.ts` § "push reject" needs a branch on the sandbox repo with commits the local tmp tree doesn't have. The scenario sets this up programmatically in `beforeEach`: push an unrelated commit to a target branch directly via `gh api PATCH repos/<sandbox>/git/refs/heads/<branch>`, then run ship + `open_pr` against the same branch → expect `BranchPushFailedError`. Cleanup in `afterEach` resets the branch.

### ED-6 — Live cancellation scenario uses a long-running fixture doc

phase 9 § F5 deferred live cancellation because the harness lacked a hook. This phase adds one: a fixture task doc (`docs/features/long.md`) designed to produce a multi-file scaffold (e.g. "build a small CLI with subcommands a/b/c, each with tests") so the live run runs long enough to cancel reliably. The doc lives under `e2e/fixtures/open-pr-sandbox/`.

### ED-7 — Cancellation timing is event-driven, not wall-clock

A3 cancels after observing a specific event in `events.ndjson` (`tool_use` or similar mid-flight marker), not after a fixed sleep. Wall-clock timing would either fire too early (before the run has work to cancel) or too late (after the run terminated naturally on a fast cursor response). The event-driven approach is robust to SDK latency variance.

### ED-8 — Shared `event-tailer.ts` is a sibling of the test files, not a new package

Lives at `e2e/scenarios/event-tailer.ts`. Imported by the 5 scenarios via relative path. Not a workspace package — single-consumer scope; adding a package adds tsconfig + package.json + lint overhead for no gain. If a non-`e2e/scenarios/` consumer ever needs it, promote then.

## Validation plan

### Track A acceptance

Each scenario, when run with `SHIP_LIVE=1 CURSOR_API_KEY=... GITHUB_TOKEN=... SHIP_E2E_SANDBOX_REPO=itsHabib/ship-live-sandbox`:

- A1 (`open-pr`): exits 0; PR url returned; `gh pr view` confirms PR open with the expected `headRefName` / `baseRefName`; phase row written.
- A2 (`ship-then-open-pr`): full chain succeeds (async ship → poll → open_pr); PR url is the agent's branch + agent's commits; `gh pr view --json files` shows agent-authored files.
- A3 (`cancel-live-ship`): run reaches `cancelled`; `events.ndjson` includes the SDK's abort observation; agent process exited within 30s of the cancel call (per the open_pr phase § Risks "cancel during open_pr" — sub-second window for `open_pr` itself, but the `ship` phase cancel can take up to 30s for the cursor SDK to wind down).
- A4 (`failure-paths`): each sub-test asserts the typed error class + post-condition (no PR / no phase / failed phase) per its description.
- A5 (`idempotent-open-pr`): second call returns the same `prUrl` with `alreadyExisted: true`; no second PR created on the sandbox repo.

Run each scenario 3× consecutively against the sandbox repo. No flakes; if a flake surfaces, it's a chip (per phase 9 model).

### Track B acceptance

Phase 9 § Validation plan, applied to the `open_pr` surface:

- L1 read complete; every confirmed finding chipped (no inline edits in this phase's branch).
- L2 CLI + MCP matrices run end-to-end; behaviors recorded; chips filed for spec/UX violations.
- L3 = Track A's 3× cleanup pass (overlaps intentionally — see Implementation plan step 13).
- Every chip has reproducer + suggested approach + out-of-scope guard.
- Queue ≤ 8 P2/P3; else Phase-01b drafted.

### Phase acceptance

- This phase doc + Track A's impl PR both merged on `main`.
- Outcome section populated with: Track A's per-scenario run table (mirroring phase 9's L3 results table); Track B's chip queue snapshot (mirroring phase 9's outcome table).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Sandbox repo permissions misconfigured | Scenarios silently force-push to the wrong place, or fail with cryptic error | First-run setup: `e2e/README.md` checklist for sandbox-repo wiring (`gh repo create`, branch-protection-off, force-push-allowed). One-time. ED-1's env-var gating means a misconfigured env at least skips loudly rather than running against the wrong repo. |
| `GITHUB_TOKEN` scopes too narrow | `open_pr` fails with cryptic auth error | Per the open_pr phase § Risks "gh auth expired", the typed `GhAuthError` carries the next-step instruction. The L4 scenario surfaces this — the cheapest place to catch scope misconfiguration. |
| Live cancellation race makes A3 flaky | Random CI failures discredit the suite | Cancel after a measured `events.ndjson` event (ED-7), not after a fixed wall-clock. Polling cadence 250ms (mirroring `startEventTailer`). |
| Branch graveyard on the sandbox repo | Manual cleanup needed | Branch naming convention (ED-3) lets a periodic cleanup script prune. Out of scope for this phase; chipped if dogfood demands it. |
| Cursor non-determinism breaks scaffold asserts | A1's "agent created src/hello.ts" check fails for some run | phase 9 § Outcome already documented this is expected (`composer-2` non-determinism on file-set choice). Asserts look at *workflow status* + *PR url* + *phase row*, not specific file paths. Per-scenario JSDoc documents which file shapes are expected vs. SDK-non-deterministic. |
| L4 quota cost blocks rerunning | Operator skips re-running scenarios | Each new scenario lists its quota in JSDoc; the suite is `SHIP_LIVE=1`-gated; CI doesn't run L4 by default. |
| Bug-smash queue overflows | Phase can't close cleanly | Standard 8-cap → Phase-01b drafted (same as phase 9). |
| Sandbox repo's GitHub Actions trigger on every push | Burns Actions quota on every L4 run | First-run setup: disable Actions on the sandbox repo via Settings → Actions → Disable. Documented in `e2e/README.md`. One-time. |
| Force-push collides with a real concurrent L4 run | Two concurrent runs corrupt each other's branches | ED-3 uses `tower/live-e2e-<workflowRunId>` — ULID-suffixed, collision-free. The only concurrency risk is two runs targeting the same `main` for `open_pr`'s base resolution; not a corruption risk, just a "second PR is opened against an already-changed base" cosmetic case. |

## Out of scope

- **Mutation testing setup.** Phase 02 of this feature.
- **Property-based state-machine tests.** Phase 03 of this feature.
- **L4 nightly CI workflow.** Defer until L4 scenario count justifies it. The on-demand `SHIP_LIVE=1` gate suffices.
- **Smashing the async-ship phase's async `ship` contract.** phase 9 covered the sync `ship` surface; the async-ship phase's deltas (return shape only) are not a new bug-class surface.
- **Rewriting tests to kill mutants.** That's Phase 02's outcome work, not this phase.
- **Contract-test framework between MCP schemas and CLI output.** the open_pr phase ED-3's `_InputMatches` is the seed; formalizing it as a framework is its own phase if signal warrants.
- **L4 against a non-GitHub forge.** the open_pr phase § Open question 4 already deferred non-GitHub forges. L4 follows.
- **Stress / load testing.** Different shape (timing-driven, not assertion-driven). Out of scope; could be a future phase if the signal shows up.

## Open questions

1. **Sandbox repo location.** `itsHabib/ship-live-sandbox` proposed. Operator confirms or names an alternative before Track A implementation lands.
2. **L4 nightly workflow.** Defer per § Out of scope; revisit in this phase's outcome.
3. **Does `cancel-live-ship.e2e.test.ts` need its own fixture or can it reuse `open-pr-sandbox/`?** Proposed: reuse; `docs/features/long.md` lives under `open-pr-sandbox/` so A3 picks it up.
4. **Should A5 be folded into A1 instead of its own file?** Proposed: separate file. A1 asserts the first-open path; A5 asserts the idempotent path. Bundling would couple the assertions and obscure failures. Keep separate; the cost is one extra fixture-tree clone, ~5s.
5. **Track B's `_InputMatches` compile-time assertion — apply to the async-ship phase's `ShipStartOutput`?** The `open_pr` phase's ED-3 flagged this as a follow-up against earlier code. Not in scope here; chip it during Track B's L1 read if operator confirms.

## Implementation plan

After this doc + `../spec.md` are reviewed and merged:

1. **One-time setup.** Operator creates `itsHabib/ship-live-sandbox`; turns off branch protection on `main`; disables GitHub Actions on the repo; documents the setup in `e2e/README.md`. (One-time, not in scope of any implementation PR.)
2. **Add `e2e/fixtures/open-pr-sandbox/`** with `README.md`, `docs/features/sandbox.md`, `docs/features/long.md`, `.gitignore`. ~50 LOC, 0× weight (fixtures count as docs per CLAUDE.md PR sizing).
3. **Extract `event-tailer.ts`** from `hello-world.e2e.test.ts:140–186` into `e2e/scenarios/event-tailer.ts`; update `hello-world.e2e.test.ts` to import it. ~100 LOC moved, ~30 LOC test (boundary cases), ~30 × 0.5 = 15 weighted.
4. **A1 — `open-pr.e2e.test.ts`.** ~100 LOC × 0.5 = 50 weighted.
5. **A2 — `ship-then-open-pr.e2e.test.ts`.** ~120 LOC × 0.5 = 60 weighted.
6. **A3 — `cancel-live-ship.e2e.test.ts`.** ~100 LOC × 0.5 = 50 weighted.
7. **A4 — `open-pr-failure-paths.e2e.test.ts`.** ~140 LOC × 0.5 = 70 weighted.
8. **A5 — `idempotent-open-pr.e2e.test.ts`.** ~80 LOC × 0.5 = 40 weighted.
9. **Update `e2e/README.md`** with the sandbox-repo + token checklist + per-scenario quota table. 0× weight.
10. **Run Track A locally 3× per scenario** against the sandbox repo. Outcome captured in this phase's "Outcome" section.
11. **Track B L1 (read pass).** Hostile-reviewer read of the open_pr phase's added files. Chip findings per phase 9 ED-2.
12. **Track B L2 (adversarial input).** Run the CLI + MCP matrices. Chip findings.
13. **Track B L3 (live dogfood).** Track A's 3× cleanup pass *is* L3 — overlaps intentionally. Findings during Track A runs that fall in phase 9's bug categories get chipped against the `open_pr` surface.
14. **Close phase.** Outcome section: Track A's run table (per phase 9's L3 table model); Track B's chip queue snapshot.

Total weighted LOC: **~285** (under "amazing"). Wall time: ~3–4h Track A + ~1 session Track B.

## Outcome

*Populated when the phase closes — Track A's per-scenario run table and Track B's chip queue snapshot, mirroring phase 9's outcome section.*

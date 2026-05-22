# Phase 01 — L4 expansion: `open_pr` coverage

Status: design draft, revision 1 (2026-05-16). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-16

> **Companion docs.** [../spec.md](../spec.md) defines the test-layer taxonomy + philosophy this phase operates inside (including § "Bug-smash cadence"). Predecessors: [ship-v1/phases/04-qe-sdet.md](../../ship-v1/phases/04-qe-sdet.md) (test-harness + 4-layer skeleton) and [ship-v1/phases/09-bug-smash.md](../../ship-v1/phases/09-bug-smash.md) (the dedicated bug-smash model — paused for now per spec.md § "Bug-smash cadence" but still valid; returns later for major surfaces). The surface under expansion is [ship-v2/phases/02-open-pr.md](../../ship-v2/phases/02-open-pr.md). The PR-sizing rule in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:**

| Item | Weight | Estimate |
|---|---|---|
| 5 new `*.e2e.test.ts` files under `e2e/scenarios/` | 0.5× × ~500 LOC = 250 | core deliverable |
| Shared `event-tailer.ts` extraction from `hello-world.e2e.test.ts` | 0.5× × ~30 LOC = 15 | helper for the 5 scenarios |
| `e2e/fixtures/open-pr-sandbox/` tree (task docs + `.gitignore`) | 0.5× × ~80 LOC = 40 | fixtures are 0.5× per CLAUDE.md PR sizing |
| `e2e/README.md` setup checklist | 0× | docs |
| **Total weighted** | | **~305 LOC** |

Comfortably under the < 500 "amazing" band. The doc PR itself is 0× (docs).

Bug-smash output (chips that surface during implementation) is governed by `spec.md` § "Bug-smash cadence" — current default is continuous, so chips file as friction is encountered, in their own task docs + PRs, not part of this phase's budget.

**Time budget:** ~3–4h impl once the design lands.

## Summary

Phase 4 stood up the L4 skeleton with one scenario (hello-world ship). Phase 9 ran the dedicated bug-smash methodology against the existing surfaces and closed with zero P0/P1 + 5 P2/P3 chips. Since then, the async-ship phase and the `open_pr` phase have landed on main without parallel L4 coverage.

This phase closes the L4 gap. 5 new live-e2e scenarios under `e2e/scenarios/`:

- **A1** — Live `open_pr` against a sandbox repo (real `gh pr create`, real GitHub).
- **A2** — `ship → open_pr` chained workflow (exercises the async-return-then-poll path).
- **A3** — Live cancellation against the real Cursor SDK.
- **A4** — Failure paths (missing `GITHUB_TOKEN`, malformed doc, push reject).
- **A5** — Idempotent re-open returns the existing PR.

Real Cursor + real GitHub; `SHIP_LIVE=1`-gated. Per `spec.md` § "Bug-smash cadence" (current default: continuous), any friction surfaced during implementation is chipped in real time — no dedicated bug-smash track in this phase. Dedicated smash returns later for major surfaces if the operator picks it.

## Functional requirements

### F1 — L4 scenarios (live e2e)

Each scenario is a single file under `e2e/scenarios/` and inherits the `SHIP_LIVE=1` gate from `e2e/vitest.e2e.config.ts`. Files mirror the existing `hello-world.e2e.test.ts` pattern: spawn the CLI binary with `tsx` against an isolated tmp tree, assert post-conditions, clean up.

**A1 — `open-pr.e2e.test.ts` — live `open_pr` against a sandbox repo.**

1. Copy `e2e/fixtures/open-pr-sandbox/` into a tmpdir.
2. `cd` into the tmp tree; `git init`; commit the initial state; `git remote add origin git@github.com:<sandbox>.git`.
3. `ship` against `docs/features/sandbox.md` to produce a workflow run with a real branch.
4. `ship open_pr <workflowRunId> --json`.
5. Assert: exit 0; `prUrl` is a real GitHub URL; `gh pr view <prNumber> --json state,headRefName,baseRefName` confirms PR open, head matches the run's branch, base is the sandbox's default branch; phase row `Phase{kind: "open_pr", status: "succeeded"}` written to the run's SQLite store.

Sandbox repo: a dedicated throwaway GitHub repo (e.g. `itsHabib/agent-sandbox`). Owned by the operator; accepts force-push from `GITHUB_TOKEN`. Each scenario run pushes a fresh branch named `tower/live-e2e-<workflowRunId>` so concurrent runs don't collide.

Requires `GITHUB_TOKEN` in env in addition to `CURSOR_API_KEY` + `SHIP_E2E_SANDBOX_REPO`. `test.skip` when any is absent.

**A2 — `ship-then-open-pr.e2e.test.ts` — chained workflow.**

Drives the agent-style call sequence: `ship` (async return) → poll `get_workflow_run` until terminal → `open_pr` against the same `workflowRunId`. Asserts the full chain succeeds and the resulting PR contains the agent's committed changes (verified via `gh pr view <n> --json files`).

Exercises the async-return-then-poll path that `hello-world.e2e.test.ts` doesn't cover (the existing hello-world scenario uses the sync `ship` return that the async-ship phase changed).

**A3 — `cancel-live-ship.e2e.test.ts` — live cancellation against real SDK.**

Starts a real ship run against a fixture doc (`e2e/fixtures/open-pr-sandbox/docs/features/long.md`) designed to take ≥30s; sends `cancel_workflow_run` after `events.ndjson` shows the agent has started (~5–10s in); asserts the run reaches `cancelled` and the SDK's abort observation appears in `events.ndjson`.

Provides L4 cancellation coverage that phase 9 § F5 explicitly skipped ("The existing harness doesn't expose a 'cancel mid-run' hook").

**A4 — `open-pr-failure-paths.e2e.test.ts` — failure modes.**

Three sub-tests (each its own `test()` block) in one file:

- *Missing `GITHUB_TOKEN`*: `open_pr` fails with the typed `GhAuthError` per the `open_pr` phase § Risks "gh auth expired"; phase row is `failed`; no PR on the sandbox repo.
- *Malformed task doc (no H1)*: `open_pr` title derivation falls back to the branch-name path per the `open_pr` phase ED-5; PR is opened with the inferred title.
- *Push reject* (sandbox `main` has commits the local tmp tree doesn't): phase row is `failed`; typed `BranchPushFailedError` recorded in the phase's `result.json`. Setup: scenario pre-pushes a commit to a target branch via `gh api`, then attempts `open_pr` against it.

**A5 — `idempotent-open-pr.e2e.test.ts` — re-call returns the existing PR.**

Calls `open_pr` twice for the same workflow run. Asserts the second call returns `alreadyExisted: true` with the same `prUrl`. Exercises the `open_pr` phase § F5 against real GitHub (the unit tests mock `gh.listOpenPrsForBranch`; this scenario hits real `gh pr list`).

### F2 — Fixture tree at `e2e/fixtures/open-pr-sandbox/`

New tree alongside the existing `test-repo/`. Contains:

- `README.md` — empty stub.
- `docs/features/sandbox.md` — task doc the agent ships in A1, A2, A5.
- `docs/features/long.md` — task doc designed to produce a multi-file scaffold that runs ≥30s on real Cursor; used by A3.
- `.gitignore` — minimal (excludes `node_modules`, build artifacts).

Per `../spec.md` § ED-4, L4 fixtures are co-located under `e2e/`; this phase adds one new tree, doesn't rearrange the layout.

### F3 — Streaming + isolation conventions

Each new scenario reuses three conventions from `hello-world.e2e.test.ts`:

- **Isolated env via `HOME` / `APPDATA` / `USERPROFILE` overrides** so the CLI's config dir resolves inside the tmpdir, not the operator's real config.
- **Event tailer** (`startEventTailer`) for visibility during a 30–90s live run. Extract the tailer from `hello-world.e2e.test.ts:140–222` (both `startEventTailer` and the `findEventsNdjson` helper it depends on) into `e2e/scenarios/event-tailer.ts` (shared helper) since 5 scenarios will use it. The existing implementation's multi-byte UTF-8 boundary handling stays — see the JSDoc on `position` for why.
- **`test.skip` on missing env vars** so the gate fails loud at the suite level, not silent at each assertion.

## Non-functional requirements

- **No new production-side code.** This phase adds L4 test files + a fixture tree + one shared test helper (`event-tailer.ts`). All test-side.
- **No new production dependency.** Helpers stay under `e2e/scenarios/`; no new pnpm-workspace package.
- **Strict TS + lint match.** The eslint relaxation for `*.test.ts` (longer functions) applies but the comment + naming rules don't change.
- **L4 quota discipline.** Each scenario burns 1+ Cursor run + 1+ GitHub PR-open per execution. Per-file JSDoc documents the cost (mirroring `hello-world.e2e.test.ts`'s "Burns one Cursor run per execution — not free").
- **Sandbox repo is operator-owned, not Ship-owned.** Ship doesn't create or destroy the sandbox repo. The repo lives at `itsHabib/agent-sandbox` (or operator-chosen path); env-injected via `SHIP_E2E_SANDBOX_REPO`. One-time setup documented in `e2e/README.md`.
- **No L4 by default in CI.** Default `make integration` doesn't touch L4. `make e2e` requires `SHIP_LIVE=1` + the env vars above.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Sandbox repo vs ephemeral repo per run | Single dedicated sandbox repo | `gh repo create` per run | Single repo: lower quota, simpler env wiring, faster local re-run. Ephemeral: zero shared state but adds quota + permissions ceremony. L4 isn't aiming for parallel CI yet — single repo suffices. |
| Force-push on each run | Yes (operator-owned sandbox repo) | Branch-per-run, never reuse | Force-push: predictable cleanup. Branch-per-run avoids force-push but the sandbox repo accumulates a branch graveyard. Force-push wins given the repo is throwaway. |
| Bug-smash as a sibling track in this phase | No (continuous for now) | Bundle a "Track B — bug-smash" alongside L4 work | Operator preference (session 2026-05-16): for now, lean on L4 + chips filed during normal work rather than carve out a dedicated smash session. Dedicated bug-smash returns later for major surfaces — see `spec.md` § "Bug-smash cadence". |
| New scenarios under `e2e/scenarios/` (flat) vs subfolder | Flat | `e2e/scenarios/open-pr/` subfolder | Flat namespace, easy `find e2e/scenarios -name '*.e2e.test.ts'`. Subfolders premature at 5 scenarios; revisit if the count grows past ~10. |
| Extract `event-tailer.ts` vs duplicate inline | Extract | Inline copy in each file | DRY at 5 use sites; one helper keeps the multi-byte UTF-8 boundary fix in one place. |
| Sub-tests in `open-pr-failure-paths.e2e.test.ts` | One file, three `test()` calls | Three separate files | The three failure modes share fixture setup; bundling halves the fixture overhead. Independent within the file via `describe` blocks. |
| Quota cost in JSDoc vs README table | Per-file JSDoc | Central table in `e2e/README.md` | Per-file: the cost is visible when reading the test. Central: requires cross-reference. Per-file wins for least-surprise; `e2e/README.md` gets a one-liner pointing at the convention. |

## Engineering decisions

### ED-1 — Sandbox repo URL via env, default unset

Each L4 scenario reads `SHIP_E2E_SANDBOX_REPO` (e.g. `itsHabib/agent-sandbox`). Unset = `test.skip`. Matches phase 9's `CURSOR_API_KEY`-driven gating and keeps the suite portable: any operator with their own sandbox repo can run the suite locally.

### ED-2 — One `git remote add origin` per scenario, no persistent worktree

Each scenario's tmp tree gets its own `git init` + `git remote add origin https://x-access-token:${GITHUB_TOKEN}@github.com/<sandbox>.git`. HTTPS-with-token over SSH because `GITHUB_TOKEN` is already required by ED-1 and works uniformly across CI, local dev, and any environment without an SSH agent; using `git@github.com:...` would silently fail on CI. The tmp tree is destroyed in `afterAll`. No persistent worktree across runs — keeps state clean, makes scenarios independently runnable.

### ED-3 — Branch naming: `tower/live-e2e-<workflowRunId>`

Branches pushed during L4 use `tower/live-e2e-<workflowRunId>` so they're identifiable and disposable. The `tower/<name>` convention is the repo-wide branch-naming standard (used across Ship; see [CLAUDE.md](../../../../CLAUDE.md) § Development workbench → tower). The `live-e2e-` prefix lets a periodic cleanup script filter (`gh api repos/<sandbox>/branches --jq '.[].name' | grep '^tower/live-e2e-' | xargs ...`).

### ED-4 — Failure-path scenario uses pre-existing remote state

`open-pr-failure-paths.e2e.test.ts` § "push reject" needs a branch on the sandbox repo with commits the local tmp tree doesn't have. The scenario sets this up programmatically in `beforeEach` using plain git rather than `gh api`:

1. In a separate tmp clone of the sandbox: `git clone https://x-access-token:${GITHUB_TOKEN}@github.com/<sandbox>.git`, `git checkout -b <target-branch>`, `echo "diverge" > diverge.txt`, `git add . && git commit -m "diverge"`, `git push -f origin <target-branch>`.
2. The scenario's main tmp tree then runs ship + `open_pr` against `<target-branch>` → expect `BranchPushFailedError`.

`afterEach` deletes the target branch via `git push origin --delete <target-branch>`. Using git directly avoids the `gh api PATCH /git/refs` 404-on-missing-ref pitfall, and the auth model uses the already-required `GITHUB_TOKEN` rather than introducing a REST-API code path.

### ED-5 — Live cancellation scenario uses a long-running fixture doc

Phase 9 § F5 deferred live cancellation because the harness lacked a hook. This phase adds one: a fixture task doc (`docs/features/long.md`) designed to produce a multi-file scaffold (e.g. "build a small CLI with subcommands a/b/c, each with tests") so the live run runs long enough to cancel reliably. The doc lives under `e2e/fixtures/open-pr-sandbox/`.

### ED-6 — Cancellation timing is event-driven, not wall-clock

A3 cancels after observing a specific event in `events.ndjson` (`tool_use` or similar mid-flight marker), not after a fixed sleep. Wall-clock timing would either fire too early (before the run has work to cancel) or too late (after the run terminated naturally on a fast cursor response). Event-driven is robust to SDK latency variance.

### ED-7 — Shared `event-tailer.ts` is a sibling of the test files, not a new package

Lives at `e2e/scenarios/event-tailer.ts`. Imported by the 5 scenarios via relative path. Not a workspace package — single-consumer scope; adding a package adds tsconfig + package.json + lint overhead for no gain. If a non-`e2e/scenarios/` consumer ever needs it, promote then.

## Validation plan

Each scenario, when run with `SHIP_LIVE=1 CURSOR_API_KEY=... GITHUB_TOKEN=... SHIP_E2E_SANDBOX_REPO=itsHabib/agent-sandbox`:

- A1 (`open-pr`): exits 0; PR url returned; `gh pr view` confirms PR open with the expected `headRefName` / `baseRefName`; phase row written.
- A2 (`ship-then-open-pr`): full chain succeeds (async ship → poll → open_pr); PR url is the agent's branch + agent's commits; `gh pr view --json files` shows agent-authored files.
- A3 (`cancel-live-ship`): run reaches `cancelled`; `events.ndjson` includes the SDK's abort observation; agent process exited within 30s of the cancel call.
- A4 (`failure-paths`): each sub-test asserts the typed error class + post-condition (no PR / no phase / failed phase) per its description.
- A5 (`idempotent-open-pr`): second call returns the same `prUrl` with `alreadyExisted: true`; no second PR created on the sandbox repo.

Run each scenario 3× consecutively against the sandbox repo. No flakes; if a flake surfaces, it's a chip (per `spec.md` § "Bug-smash cadence" — continuous chip-filing).

### Phase acceptance

- This phase doc + the impl PR both merged on `main`.
- Outcome section populated with the per-scenario run table.
- Any chips filed during implementation are linked in the outcome section.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Sandbox repo permissions misconfigured | Scenarios silently force-push to the wrong place, or fail with cryptic error | First-run setup: `e2e/README.md` checklist for sandbox-repo wiring (`gh repo create`, branch-protection-off, force-push-allowed). One-time. ED-1's env-var gating means a misconfigured env at least skips loudly rather than running against the wrong repo. |
| `GITHUB_TOKEN` scopes too narrow | `open_pr` fails with cryptic auth error | Per the `open_pr` phase § Risks "gh auth expired", the typed `GhAuthError` carries the next-step instruction. The L4 scenario surfaces this — the cheapest place to catch scope misconfiguration. |
| Live cancellation race makes A3 flaky | Random CI failures discredit the suite | Cancel after a measured `events.ndjson` event (ED-6), not after a fixed wall-clock. Polling cadence 250ms (mirroring `startEventTailer`). |
| Branch graveyard on the sandbox repo | Manual cleanup needed | Branch naming convention (ED-3) lets a periodic cleanup script prune. Out of scope for this phase; chipped if dogfood demands it. |
| Cursor non-determinism breaks scaffold asserts | A1's "agent created src/hello.ts" check fails for some run | Phase 9 § Outcome already documented this is expected (`composer-2` non-determinism on file-set choice). Asserts look at *workflow status* + *PR url* + *phase row*, not specific file paths. Per-scenario JSDoc documents which file shapes are expected vs. SDK-non-deterministic. |
| L4 quota cost blocks rerunning | Operator skips re-running scenarios | Each new scenario lists its quota in JSDoc; the suite is `SHIP_LIVE=1`-gated; CI doesn't run L4 by default. |
| Sandbox repo's GitHub Actions trigger on every push | Burns Actions quota on every L4 run | First-run setup: disable Actions on the sandbox repo via Settings → Actions → Disable. Documented in `e2e/README.md`. One-time. |
| Force-push collides with a real concurrent L4 run | Two concurrent runs corrupt each other's branches | ED-3 uses `tower/live-e2e-<workflowRunId>` — ULID-suffixed, collision-free. The only concurrency risk is two runs targeting the same `main` for `open_pr`'s base resolution; not a corruption risk, just a "second PR is opened against an already-changed base" cosmetic case. |

## Out of scope

- **Mutation testing setup.** [Phase 02](02-mutation-testing.md) of this feature.
- **Property-based state-machine tests.** [Phase 03](03-property-based-state-machine.md) of this feature.
- **L4 nightly CI workflow.** Defer until L4 scenario count justifies it. The on-demand `SHIP_LIVE=1` gate suffices.
- **Smashing the async-ship phase's async `ship` contract.** Phase 9 covered the existing `ship` surface; the async-ship phase's deltas (return shape only) are not a new bug-class surface.
- **Contract-test framework between MCP schemas and CLI output.** The `open_pr` phase ED-3's `_InputMatches` is the seed; formalizing it as a framework is its own phase if signal warrants.
- **L4 against a non-GitHub forge.** The `open_pr` phase § Open question 4 already deferred non-GitHub forges. L4 follows.
- **Stress / load testing.** Different shape (timing-driven, not assertion-driven). Out of scope; future phase if signal shows up.

## Open questions

1. **Sandbox repo location.** `itsHabib/agent-sandbox` proposed. Operator confirms or names an alternative before implementation lands.
2. **L4 nightly workflow.** Defer per § Out of scope; revisit in this phase's outcome.
3. **Does `cancel-live-ship.e2e.test.ts` need its own fixture or can it reuse `open-pr-sandbox/`?** Proposed: reuse; `docs/features/long.md` lives under `open-pr-sandbox/` so A3 picks it up.
4. **Should A5 be folded into A1 instead of its own file?** Proposed: separate file. A1 asserts the first-open path; A5 asserts the idempotent path. Bundling would couple the assertions and obscure failures. Keep separate; the cost is one extra fixture-tree clone, ~5s.

## Implementation plan

After this doc + `../spec.md` are reviewed and merged:

1. **One-time setup.** Operator creates `itsHabib/agent-sandbox`; turns off branch protection on `main`; disables GitHub Actions on the repo; documents the setup in `e2e/README.md`. (One-time, not in scope of any implementation PR.)
2. **Add `e2e/fixtures/open-pr-sandbox/`** with `README.md`, `docs/features/sandbox.md`, `docs/features/long.md`, `.gitignore`. ~80 LOC × 0.5 = ~40 weighted (fixtures are 0.5× per CLAUDE.md PR sizing).
3. **Extract `event-tailer.ts`** from `hello-world.e2e.test.ts:140–186` into `e2e/scenarios/event-tailer.ts`; update `hello-world.e2e.test.ts` to import it. ~100 LOC moved, ~15 weighted.
4. **A1 — `open-pr.e2e.test.ts`.** ~100 LOC × 0.5 = 50 weighted.
5. **A2 — `ship-then-open-pr.e2e.test.ts`.** ~120 LOC × 0.5 = 60 weighted.
6. **A3 — `cancel-live-ship.e2e.test.ts`.** ~100 LOC × 0.5 = 50 weighted.
7. **A4 — `open-pr-failure-paths.e2e.test.ts`.** ~140 LOC × 0.5 = 70 weighted.
8. **A5 — `idempotent-open-pr.e2e.test.ts`.** ~80 LOC × 0.5 = 40 weighted.
9. **Update `e2e/README.md`** with the sandbox-repo + token checklist + per-scenario quota table. 0× weight.
10. **Update `CLAUDE.md` § Docs layout** with a one-liner link to `docs/features/qe-sdet/spec.md` § Test-layer taxonomy. Closes spec.md Open Q 2 (taxonomy lives in this feature folder, linked from CLAUDE.md rather than inlined). 0× weight (docs).
11. **Run locally 3× per scenario** against the sandbox repo. Outcome captured in this phase's "Outcome" section.

Total weighted LOC: **~305** (under "amazing"). Wall time: ~3–4h.

## Outcome

*Populated when the phase closes — per-scenario run table (mirroring phase 9's L3 results table) + any chips filed during implementation per `spec.md` § "Bug-smash cadence".*

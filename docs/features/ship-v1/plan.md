# Plan

Execution plan for getting Ship V1 shipped. Companion to [spec.md](spec.md), which is the design spec — this file is "in what order, with what acceptance criteria, with what's needed from you at each step."

Mark phases done by checking boxes. Don't start a phase before its predecessor is done.

Phases that introduce real surface area get their own task doc under `phases/` (functional/non-functional req, tradeoffs, engineering decisions, API contracts, data model, validation plan, risks, open questions). The doc is reviewed before any implementation lands. Phase 0 and Phase 1 predate this convention; from Phase 2 forward each gets one.

---

## Phase 0 — SDK spike ✅ (done 2026-05-06)

**Goal:** Verify `@cursor/sdk` behaves the way [../../cursor-sdk-typescript.md](../../cursor-sdk-typescript.md) claims, before we scaffold around assumptions.

- [x] Write `spike/{package.json, tsconfig.json, local-run.ts, README.md}`.
- [x] Write root `.gitignore`.
- [x] `cd spike && pnpm install`.
- [x] `$env:CURSOR_API_KEY = "..."`.
- [x] `pnpm start` from `spike/`. First run: 119 events, 67s, `composer-2`, completed cleanly.
- [x] Append findings to [../../cursor-sdk-typescript.md § Spike findings](../../cursor-sdk-typescript.md#spike-findings-run-1-2026-05-06).
- [ ] (Followup, not blocking) Test cancellation via SIGINT — the first run completed naturally so the abort path is unexercised.

**Resolved decisions:**
- Default model: `composer-2`.
- `RunResult.result` IS the final assistant text — `summary.md` is just that string written to disk. No event-scan parsing needed.
- `RunResult.git` is omitted (not empty) when there are no branches; check `result.git?.branches`.
- `pnpm` 10 blocks `sqlite3`'s native postinstall by default. Root `package.json` will need `pnpm.onlyBuiltDependencies` allowlisting `sqlite3`, `better-sqlite3`, `esbuild`.
- Confidence to scaffold Phase 1: yes.

---

## Phase 1 — Monorepo scaffold ✅ (done 2026-05-06)

**Goal:** stand up the dev surface. No package code yet.

- [x] Root `package.json` (private, pnpm workspaces, scripts: `lint`, `format`, `format:check`, `typecheck`, `test`, `check`).
- [x] `pnpm-workspace.yaml` (`packages/*`).
- [x] `tsconfig.base.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride` + `noFallthroughCasesInSwitch` + `noPropertyAccessFromIndexSignature` + `verbatimModuleSyntax` + composite/incremental). ES2022 target.
- [x] `tsconfig.json` (root project-references entry; empty refs/include for now).
- [x] `eslint.config.js` (flat config; `typescript-eslint` strict-type-checked + stylistic-type-checked, perfectionist for sort-imports / sort-named-imports, complexity ≤ 15, max-lines-per-function ≤ 80, max-statements ≤ 50, max-depth ≤ 4, max-params ≤ 5, consistent-type-imports, eslint-config-prettier last).
- [x] `.prettierrc`, `.prettierignore` (markdown design docs ignored to preserve author style).
- [x] `vitest.config.ts` (per-package `src/**/*.test.ts` + `test/**/*.test.ts` glob; `passWithNoTests: true` for empty workspace; v8 coverage).
- [x] `Makefile` (install / lint / lint-fix / format / format-check / typecheck / test / test-watch / check / ci / clean).
- [x] `.github/workflows/ci.yml` (push + PR; ubuntu + windows matrix; pnpm 10 + node 22; verifies no ignored build scripts; runs typecheck + lint + format:check + test).
- [x] `README.md` (pitch + `make check` instructions).
- [x] `pnpm.onlyBuiltDependencies` allowlist for `sqlite3`, `better-sqlite3`, `esbuild`.

**Validated:** `make check` passes on the empty workspace. All four substeps green (typecheck, lint, format:check, test).

**Not yet:** initial git commit / first PR — held until you ask.

---

## Phase 2 — V1 type system: `packages/workflow` + `packages/mcp` ✅ (done 2026-05-06)

📄 [phases/02-type-system.md](phases/02-type-system.md) — task doc (functional/non-functional req, tradeoffs, decisions, API contract, validation plan, risks, open questions). Naming history: revisions 0–1 shipped under `packages/domain`; revision 2 renamed to `packages/contracts`; revision 3 split into `packages/workflow` (workflow entities, state machine, IDs) and `packages/mcp` (MCP tool I/O, depends on `@ship/workflow`).

**Goal:** all V1 types + Zod schemas, no side effects.

- [x] Review and approve `phases/02-type-system.md`.
- [x] Implement per the doc's "Implementation plan" section.

**Validated:** `make check` passes from repo root (typecheck + lint + format:check + test). All tests pass; per-package `pnpm --filter @ship/workflow test` and `pnpm --filter @ship/mcp test` both exit 0 with their tests run (per-package `vitest.config.ts` in each).

---

## Phase 3 — `packages/store` ✅ (done 2026-05-08)

📄 [phases/03-store.md](phases/03-store.md) — task doc (functional/non-functional req, tradeoffs, decisions, API contract, validation plan, risks, open questions).

**Goal:** SQLite persistence with hand-written SQL + Zod parse on hydration. No ORM.

- [x] Review and approve `phases/03-store.md`.
- [x] Implement per the doc's "Implementation plan" section.

**Validated:** `make check` passes from repo root (typecheck + lint + format:check + test). All 172 tests pass; per-package `pnpm --filter @ship/store test` exits 0 with 57 tests run (migrations + per-table CRUD + connection PRAGMAs + atomicity + barrel smoke).

---

## Phase 4 — QE/SDET: `packages/test-harness` + scenario suite + coverage gates ✅ (done 2026-05-09)

📄 [phases/04-qe-sdet.md](phases/04-qe-sdet.md) — task doc.

**Goal:** lock in the test taxonomy (unit / scenario / e2e) before more packages land. Build the harness + initial scenario suite at the storage level (Cursor / Tower mocked, since they don't exist yet); set up CI coverage gates and the e2e skeleton that phases 5–9 plug their real adapters into.

- [x] Review and approve `phases/04-qe-sdet.md`.
- [x] Implement per the doc's "Implementation plan" section.

**Validated:** `make check` passes from repo root (typecheck + lint + format:check + 195 tests). `make coverage` passes per-package thresholds (`@ship/workflow` / `@ship/mcp` 100% at 95/90; `@ship/store` 92.34% / 88.82% at 90/85; `@ship/test-harness` 100% at 80/75). Five scenarios under `packages/test-harness/scenarios/` exercise happy-path / cancel-mid-flight / phase-failure / list-filters / concurrent-readers. E2E skeleton at `e2e/` exits cleanly with `SHIP_LIVE` unset.

---

## Phase 5 — `packages/cursor-runner`

📄 [phases/05-cursor-runner.md](phases/05-cursor-runner.md) — task doc.

**Goal:** the only `@cursor/sdk` importer. Substrate-agnostic `CursorRunner` interface + `LocalCursorRunner` impl + `FakeCursorRunner` for downstream tests. Cloud impl is V2+ behind the same interface. Implementation grounded in the [spike findings](../../cursor-sdk-typescript.md#spike-findings-run-1-2026-05-06), not the SDK reference doc alone.

- [ ] Review and approve `phases/05-cursor-runner.md`.
- [ ] Implement per the doc's "Implementation plan" section (lands as 5a + 5b sub-PRs).

**Done when:** `pnpm --filter @ship/cursor-runner test` green; `make check` + `make coverage` pass; ED-2 import-isolation test (lives in `packages/cursor-runner/test/`) verifies no `@cursor/sdk` leak outside the package. (Harness extension — `cursor: FakeCursorRunner` field on `Harness` plus a workflow-lifecycle scenario — is deferred to Phase 6, where `core` makes the scenario meaningful.)

---

## Phase 6 — `packages/core`

**Goal:** `ShipService` — the workflow brain. Holds the state machine. Workspace-agnostic: `ship(input)` accepts a workdir path the caller supplies; Ship doesn't create or destroy workspaces.

- [ ] `createShipService({ store, cursor, fs, clock, config })`. (No Tower dependency.)
- [ ] Methods: `ship(input)`, `getRun(id)`, `listRuns(filter)`, `cancelRun(id)`.
- [ ] State transitions enforce the rules in spec.md § "State transitions".
- [ ] Artifact write logic (prompt.md, task-doc.md, events.ndjson, result.json, summary.md).
- [ ] Vitest: state transitions, artifact paths, error paths, all using fakes from #5.
- [ ] Extend `@ship/test-harness` scenarios to cover full-stack flows through `ShipService`.

**Done when:** `pnpm --filter core test` green; an end-to-end test using fakes goes from `pending` → `succeeded`.

---

## Phase 7 — `packages/cli`

**Goal:** the binary you can invoke locally. Same `ShipService` instance the MCP server uses.

- [ ] Commander setup.
- [ ] Subcommands: `ship`, `status`, `list`, `cancel`.
- [ ] `ship ship <docPath> --workdir <path>` (default `--workdir .`).
- [ ] Smoke tests via fake-runner-backed service.

**Done when:** `pnpm --filter cli test` green; `node packages/cli/dist/cli.js list` runs end-to-end against a real local store.

---

## Phase 8 — `packages/mcp-server`

**Goal:** stdio MCP server exposing the four V1 tools.

- [ ] MCP TS SDK v1.x as server.
- [ ] Tool registry: `ship`, `get_workflow_run`, `list_workflow_runs`, `cancel_workflow_run`.
- [ ] Resource: `ship://runs/{id}`.
- [ ] Smoke tests via fake-runner-backed service.

**Done when:** Cursor or Claude Code connects, sees the four tools, and can call `list_workflow_runs` against a real local store.

---

## Phase 9 — Live integration test + dogfood

**Goal:** the first real `ship` invocation against a real Cursor SDK on a workdir the test sets up. Swaps the `FakeCursorRunner` in `@ship/test-harness`'s e2e harness for the real one built in Phase 5. The workdir comes from whatever the test prefers — `git worktree`, plain `cp`, Tower if installed; Ship doesn't care.

- [ ] Test repo: the existing `e2e/fixtures/test-repo/` fixture, copied into a tmp workdir at test setup.
- [ ] Run `ship ship docs/features/hello.md --workdir <tmp>` behind `SHIP_LIVE=1`.
- [ ] Assert: files changed in the workdir, tests pass there, `result.json` populated, `summary.md` non-empty.
- [ ] Then dogfood: write the next Ship feature as a task doc and ship it through Ship.

**Done when:** V1 is real, dogfooded, and green.

---

## What's not in V1

(See spec.md § "Non-goals" for the full list.) Worth restating because scope creep is the #1 risk:

- No PR opening (that's the first V2 phase, ~30 lines of `gh` invocation).
- No reviews, no CI repair, no comment management.
- No cloud Cursor runtime.
- No recipes, no dashboard.
- Communication-layer primitives are a separate sibling project, not a Ship V2 phase.
- No multi-tenant features, no hosted service.

Each of those is a phase that composes onto V1 cleanly when V1 is done — that's the whole point of the package boundaries.

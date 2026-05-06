# Plan

Execution plan for getting Ship V1 shipped. Companion to [spec.md](spec.md), which is the design spec — this file is "in what order, with what acceptance criteria, with what's needed from you at each step."

Mark phases done by checking boxes. Don't start a phase before its predecessor is done.

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

## Phase 2 — `packages/shared`

**Goal:** all V1 types + Zod schemas, no side effects, no other package deps.

- [ ] `WorkflowStatus`, `PhaseStatus`, `PhaseKind`, `WorkflowRun`, `Phase`, `WorktreeRef`, `CursorRunRef`, `WorkflowPolicy`, MCP tool inputs/outputs.
- [ ] Zod schemas + `z.infer` types.
- [ ] ULID helpers (or a small adapter around `ulid`).
- [ ] Vitest: every schema accepts valid input, rejects invalid input.

**Done when:** `pnpm --filter shared test` is green and exports compile clean for downstream packages.

---

## Phase 3 — `packages/store`

**Goal:** SQLite persistence with typed queries.

- [ ] `better-sqlite3` + Drizzle.
- [ ] Schema matching spec.md § "SQL schema".
- [ ] Migrations runner.
- [ ] `Store` interface + impl: `createWorkflowRun`, `updateStatus`, `appendPhase`, `updatePhase`, `getRun`, `listRuns`, `cancelRun`.
- [ ] Vitest: round-trip every entity, idempotent cancel, `listRuns` filtering, fresh-DB migration.

**Done when:** `pnpm --filter store test` green.

---

## Phase 4 — `packages/tower-adapter`

**Goal:** Tower MCP client via stdio.

- [ ] MCP TS SDK v1.x as client.
- [ ] `TowerAdapter` interface: `getRepo`, `addWorktree`, `getWorktree`, `removeWorktree`.
- [ ] Map Tower MCP responses into Ship's domain types (no leaks).
- [ ] Vitest: against a recorded transcript or a local fake Tower MCP server.

**Decisions you'll need to weigh in on:**
- Does Tower MCP currently expose JSON output for what we need? (Open question #1 in the original design doc.)
- Worktree base path — adopt Tower's default (`<repo>/.worktrees/<name>`)?

**Done when:** `pnpm --filter tower-adapter test` green; integration test against your real local Tower passes manually.

---

## Phase 5 — `packages/cursor-runner`

**Goal:** the only `@cursor/sdk` importer. `CursorRunner` interface + impl + `FakeCursorRunner` for downstream tests.

- [ ] Implement against the spike findings, not the SDK reference doc alone.
- [ ] NDJSON event writer (with whatever batching the spike showed we need).
- [ ] SIGINT/AbortSignal wired to `run.cancel()`.
- [ ] `FakeCursorRunner` exported under `cursor-runner/test/fake.ts` — scriptable event sequence, configurable success/fail/cancel.
- [ ] Vitest: prompt assembly, options mapping, fake-driven success and failure paths.

**Done when:** `pnpm --filter cursor-runner test` green; the same trivial spike prompt now runs through the package and produces equivalent output.

---

## Phase 6 — `packages/core`

**Goal:** `ShipService` — the workflow brain. Holds the state machine.

- [ ] `createShipService({ store, tower, cursor, fs, clock, config })`.
- [ ] Methods: `ship(input)`, `getRun(id)`, `listRuns(filter)`, `cancelRun(id)`.
- [ ] State transitions enforce the rules in spec.md § "State transitions".
- [ ] Artifact write logic (prompt.md, task-doc.md, events.ndjson, result.json, summary.md).
- [ ] Vitest: state transitions, artifact paths, error paths, all using fakes from #4 and #5.

**Done when:** `pnpm --filter core test` green; an end-to-end test using fakes goes from `pending` → `succeeded`.

---

## Phase 7 — `packages/cli`

**Goal:** the binary you can invoke locally. Same `ShipService` instance the MCP server uses.

- [ ] Commander setup.
- [ ] Subcommands: `ship`, `status`, `list`, `cancel`.
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

**Goal:** the first real `ship` invocation against your real Cursor SDK and real Tower, on a trivial test repo.

- [ ] Test repo: throwaway dir registered in Tower with a one-line task doc ("add a `hello` function and a test for it").
- [ ] Run `ship ship docs/features/hello.md --repo <testrepo>`.
- [ ] Assert: worktree created, files changed, tests pass in the worktree, `result.json` populated, `summary.md` non-empty.
- [ ] Then dogfood: write the next Ship feature as a task doc and ship it through Ship.

**Done when:** V1 is real, dogfooded, and green.

---

## What's not in V1

(See spec.md § "Non-goals" for the full list.) Worth restating because scope creep is the #1 risk:

- No PR opening (that's the first V2 phase, ~30 lines of `gh` invocation).
- No reviews, no CI repair, no comment management.
- No cloud Cursor runtime.
- No recipes, no communication-layer primitives, no dashboard.
- No multi-tenant features, no hosted service.

Each of those is a phase that composes onto V1 cleanly when V1 is done — that's the whole point of the package boundaries.

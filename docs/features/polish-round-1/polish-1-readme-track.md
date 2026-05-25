**Status**: draft
**Owner**: claude-code:michael
**Date**: 2026-05-25
**Related**: dossier task `polish-1-readme-track` (id: `tsk_01KSE9PJCQS10J2SENCC1MNBPM`), polish-round-1 phase

# README polish — top-level rewrite + 6 missing package READMEs + 2 refreshes — design spec

## Scope

| Bucket | Files | Est. raw LOC | Weighted |
|---|---|---|---|
| Top-level rewrite | `README.md` | ~80 | 0 (docs) |
| New package READMEs | 6 files at ~40 LOC | ~240 | 0 |
| Refresh existing | 2 files (~80 LOC delta) | ~80 | 0 |
| **Total** | | ~400 raw | **0 weighted** |

Band: **amazing** trivially — docs are 0× weight per CLAUDE.md PR sizing.

## Goal

Every README on `main` is either stale or missing. Top-level says *"pre-implementation; Phase 1 only"* — V1 feature-complete and V2 phases 01/03/04/08 shipped. 6 of 8 packages have zero README. Single PR refreshing the whole docs surface.

## Behavior / fix

### 1. Top-level `README.md` (full rewrite)

Replace from scratch with these sections:

- **What Ship is** (1 paragraph) — repo-native MCP toolkit driving cursor agents against task docs, persisting workflow state, dogfooded on itself.
- **Status** — V1 feature-complete; V2 phases 01 (async ship), 03 (subagents), 04 (cursor cloud runner), 08 (Agent.resume) on `main`. `open_pr` verb removed in PR #81; cause-chain diagnostics + boolean-coerce fix landed in PR #82.
- **Quick start** — install, `make check`, the dogfood pattern (write task doc → `mcp__ship__ship` against worktree → poll terminal).
- **Architecture** — 1-paragraph map of the 8 packages: `cli` / `core` / `cursor-runner` / `mcp` / `mcp-server` / `store` / `test-harness` / `workflow`. Each package name links to its package README (the next section creates them).
- **Develop** — `pnpm install`, `make check`, `pnpm run test:watch`, plus the mutation entrypoint added by `polish-1-mutation-track` (`gh workflow run mutation.yml`). If that line is already in `README.md` from the mutation track's small addition, expand it; otherwise add it cleanly.
- **Docs map** — link `docs/features/<feature>/spec.md` + `plan.md` + `phases/NN-*.md` convention.
- **Workbench** — brief link to CLAUDE.md's "Dev workbench" section.

### 2. New package READMEs (6 packages, currently missing)

Each follows the same 5-section shape:

1. **What this package owns** (1–2 sentences).
2. **Public surface** — main exports / interfaces, one line each.
3. **How it composes** with sibling packages.
4. **When to swap it** — what would change if this layer were replaced (Ship's substitutability principle).
5. **Develop / test commands** if package-specific.

Files to create:

- `packages/cli/README.md` — verbs, composition with `core` + `cursor-runner`.
- `packages/cursor-runner/README.md` — `CursorRunner` interface + `LocalCursorRunner` / `CloudCursorRunner` impls + SDK-isolation invariant (ED-2).
- `packages/mcp/README.md` — Zod boundary types shared between server / client; what's exported (`ShipInput`, `ShipOutput`, `CloudRunSpec`, `cursorRunRuntimeSchema`, etc.).
- `packages/mcp-server/README.md` — tool registration, how it wires `core` services. Note the `open_pr` removal in PR #81.
- `packages/store/README.md` — SQLite schema overview + `Store` interface + the `listResumableCloudCursorRuns` resume hook.
- `packages/test-harness/README.md` — fixtures it exports + when to use vs writing inline fakes.

### 3. Refresh existing READMEs

- `packages/core/README.md` (currently 25 lines, predates V2 phases 04 + 08):
  - Add `ShipService.startShip` (async kickoff added in V2 phase 01).
  - Add `resumeOrphanedRuns` + `resumeReady` (V2 phase 08).
  - Add `finalizeFailure`'s structured `errorChain` + `safeStringifyFailureResult` JSON-hostile-value handling (PR #82).
  - Strip any `open_pr` references (gone in PR #81).
  - Apply the same 5-section shape as the new READMEs.

- `packages/workflow/README.md` (currently 14 lines):
  - Mention the `open_pr` tombstone in `phaseKindSchema` (PR #81 kept it for DB hydration of historical rows).
  - Mention the existing `transitions.properties.test.ts` as a model — and the upcoming expansion in `polish-1-property-track`.
  - Apply the same 5-section shape.

## Acceptance

- Top-level README reflects current main HEAD reality (V1 done + V2 phases 01/03/04/08 shipped; `open_pr` removed; cause-chain diagnostics landed).
- All 8 package READMEs follow the same 5-section shape.
- No stale `open_pr` references anywhere in the README surface.
- Every package README is between 25 and 100 lines (too thin = useless; too thick = deep design docs belong in `docs/features/`).
- All cross-links resolve.

## Test plan

- Manual grep: `grep -r "open_pr\|pre-implementation\|Phase 1 only" README.md packages/*/README.md` returns nothing.
- Manual grep: `grep -rL "What .* owns\|Public surface\|How it composes" packages/*/README.md` returns nothing (every package README has the section headers).
- `markdown-link-check` (if available) on every README, otherwise spot-check key cross-links by hand.

## Non-goals

- API reference generation. Hand-written prose only.
- Marketing copy / competitive comparison.
- Restructuring `docs/features/` layout.
- Updating any README sections in `pers/work-driver.md` or other operator-side notes.

## Dependency

Soft dep on `polish-1-mutation-track`: the top-level README's mutation-invocation line is more accurate if mutation track merges first (then the line points at the real `gh workflow run mutation.yml`). If this PR fires first, leave the line as the documented invocation anyway — the workflow will land before any reader needs it, and a stale link for ~hours is cheaper than blocking on serialization.

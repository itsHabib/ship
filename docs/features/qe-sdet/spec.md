# QE / SDET

Status: design draft, revision 0 (2026-05-16). Awaiting review before any phase implementation lands.
Owner: itsHabib
Date: 2026-05-16

> **Companion docs.** [phases/01-l4-expansion-and-bug-smash.md](phases/01-l4-expansion-and-bug-smash.md) is the first concrete phase under this feature. Predecessors: [ship-v1/phases/04-qe-sdet.md](../ship-v1/phases/04-qe-sdet.md) (test-harness package + 4-layer skeleton, done) and [ship-v1/phases/09-bug-smash.md](../ship-v1/phases/09-bug-smash.md) (hostile-reviewer pass, done). This feature picks up where those left off and codifies the test taxonomy + philosophy so future phases don't re-litigate them.

## Summary

QE / SDET is a long-lived feature: every new Ship surface (`ship` + cancel; `open_pr`; future `review` / `ci_fix`) compounds the test matrix. Instead of bolting testing onto each per-feature phase doc as a footnote, this feature owns it as a first-class slot — with its own spec, its own phases, and its own PR cadence.

The spec codifies the test-layer taxonomy (L1 unit / L2 scenario / L3 integration / L4 live e2e) and the philosophy ("coverage is a floor, mutation score is the ceiling"). The phases ship the concrete work: live-e2e expansion + bug-smash (Phase 01), mutation testing (Phase 02), property-based state-machine tests (Phase 03). Each phase is its own design PR, then its own impl PR (where there is one).

The shape is intended to be templatable — the four-layer taxonomy + the doc structure should drop cleanly into Dossier and sibling projects without rework.

## Goals

- **Codify the test-layer taxonomy.** Four layers, each with a single purpose and a single run-mode gate. Future phase docs reference the taxonomy instead of re-defining it.
- **Treat QE as a feature, not a footnote.** Each new technique (live e2e, bug-smash, mutation, property-based) lands as its own phase doc + PR. Reviewers see the test surface at design time, not after a 1000-LOC PR drops.
- **Keep tests first-class code.** Same eslint config, same naming rules, same `//`-only comment convention as production source.
- **Make the QE shape portable.** Dossier and future projects copy this `spec.md` + a single phase doc and get the same conventions without re-deriving them.

## Non-goals

- Replace phase 4's `@ship/test-harness` package. It's still the home for the `Harness` class + scenario helpers; this feature builds on it.
- Replace phase 9's bug-smash methodology. Phase 9's ED-1 validation bar + ED-2 chip checklist remain the bar. This feature's bug-smash phases re-run the methodology against new surfaces; they don't redefine it.
- Define coverage thresholds. Those live per-package in each package's `vitest.config.ts` (phase 4 § F4). This feature observes them, doesn't move them.
- Define the e2e fixture-repo shape. `e2e/fixtures/test-repo/` is the existing convention; new phases add sibling fixture trees rather than rearrange.
- Migrate the phase 4 / phase 9 doc content here. Cross-link, don't move — see Open question 1.

## Test-layer taxonomy

Four layers, in order of breadth. Every test in the repo falls into exactly one.

| Layer | Path | Purpose | Speed | Run mode |
|---|---|---|---|---|
| **L1 — Unit** | `packages/<pkg>/src/**/*.test.ts` | One module under test, fakes/test doubles for everything else | < 100ms per file | Every commit |
| **L2 — Scenario** | `packages/test-harness/scenarios/*.scenario.test.ts` | Multi-step flows spanning ≥2 packages; fakes for system boundaries (SDKs, MCP transports) | < 1s per scenario | Every commit |
| **L3 — Integration** | `e2e/integration/*.integration.test.ts` | Real fs + real SQLite file + real subprocess of `tsx src/bin.ts` (or stdio MCP server); `FakeCursorRunner` / `gh`-stub injected via env to skip third-party quota | 1–5s per test | Every commit |
| **L4 — Live e2e** | `e2e/scenarios/*.e2e.test.ts` | Real SDKs + real workdir + (where applicable) real third-party services (Cursor, GitHub). Slow, costly, gated. | 20–120s per scenario | `SHIP_LIVE=1` only |

Each layer answers a different question:

- L1: does this function or class work in isolation?
- L2: does this multi-package flow work end-to-end with all the seams stubbed?
- L3: does the binary actually run? does the wiring boot? does the persisted state round-trip on real disk?
- L4: does the real-world system actually do what we say it does?

Skipping a layer is a smell. A surface with L1 + L4 but no L2/L3 means CI is either redundant (L1 + L4 overlap) or thin (L4 hides the seam bugs L2/L3 catch).

## Philosophy

These are the principles every phase under this feature is reviewed against.

### Coverage is a floor, mutation score is the ceiling

Per-package coverage thresholds (phase 4 § F4) gate against regression: deleting a test drops coverage and fails CI. But coverage doesn't measure *what* the test catches — only that the line was visited. Mutation testing (Phase 02 of this feature) closes that gap by mutating the source and re-running the suite; surviving mutants are tests that don't actually catch their target.

### Live e2e is the most expensive layer, so it is the smallest

L4 burns Cursor quota, hits real GitHub, and takes minutes. Each new L4 scenario must justify its existence over an L3 equivalent. Default for a new feature: "add an L3 integration test using a fake/stub; add an L4 only when the failure mode is invisible at L3" — e.g. SDK-specific stream shapes, real-network rate-limit handling, third-party state changes (GitHub PRs, branch protection).

### Bug-smash is a phase, not a footnote

Per phase 9, a hostile-reviewer pass + adversarial-input matrix + live dogfood is its own phase with its own PR. New surfaces (`open_pr`, future `review`, `ci_fix`) re-run the same methodology — fresh phase doc, fresh chip queue, same ED-1 validation bar. Bundling bug-smash into a feature's implementation PR loses the design-time review.

### Tests are first-class code

The repo's eslint rules apply to test files. The `//`-only comment convention applies to test files. The naming rules (no `And`/`Or` in function names, no `Impl` suffix) apply to test helpers. The PR-sizing rule applies to test files (at 0.5×). Test code drift becomes prod code drift.

### One technique per phase

Mutation testing, property-based testing, contract testing, fuzz testing — each is its own phase. Bundling them inflates review surface and couples unrelated decisions. CLAUDE.md's PR-sizing rule on splitting at step boundaries applies: one technique → one phase → one PR.

## Planned phases

Each gets its own `phases/NN-...md` doc, reviewed and merged before implementation lands. Phase ordering reflects sequencing constraints, not priority.

1. **[01 — L4 expansion + `open_pr` bug-smash](phases/01-l4-expansion-and-bug-smash.md).** Two tracks in one phase. Track A expands the L4 suite from one scenario (hello-world ship) to cover the `open_pr` surface end-to-end against a sandbox repo + a `ship → open_pr` chain + cancellation against the real SDK + failure paths + idempotency. Track B re-runs phase 9's bug-smash methodology against `open_pr` (CLI + MCP). Output: code (Track A) + chips (Track B).
2. **02 — Mutation testing (planned).** Wire `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` against `@ship/core` (workflow state machine + ship service) as a nightly-only CI step. Surviving mutants become chips per phase 9's ED-2 checklist. Out of scope: rewriting tests to kill mutants — that's the work each chip's PR does.
3. **03 — Property-based state-machine tests (planned).** Wire `fast-check` against `@ship/workflow`'s `Phase.kind × status` transition graph. Each valid/invalid transition becomes a property; invariants over the state graph (e.g. "every terminal status sets `endedAt`", "no `pending` row has an `endedAt`") are exhaustively checked. Replaces or supplements the hand-written transition tests in `packages/workflow/`.

Each later phase lands when its predecessor is reviewed + merged, not before. Phase 01 is the only one in design today.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Feature folder vs. nesting under feature-of-the-day | Standalone `docs/features/qe-sdet/` | New phase under each feature folder (`ship-v2/phases/03-qe.md`, etc.) | QE compounds across all features; nesting forces re-derivation per feature. Standalone is portable across projects. |
| Single phase doc vs. spec + phases | `spec.md` + `phases/` | One omnibus doc | Each technique deserves its own PR. The spec captures what's portable; phase docs capture what's project-specific. |
| L4 gating | `SHIP_LIVE=1` env, on-demand | Nightly CI workflow | phase 4 § F4 already deferred a nightly workflow until there's enough L4 to justify it. Phase 01 may flip this depending on how many scenarios land. |
| Mutation testing tool | Stryker (`@stryker-mutator/*`) | Mutators bundled into vitest (none exist) | Stryker is the de facto Node mutation tool; vitest-runner integration is first-class. No competing maintained alternative. |
| Property-based testing tool | `fast-check` | jsverify (abandoned), QuickCheck-via-shim | fast-check is actively maintained, TS-native, integrates with vitest via `test.prop(...)`. |
| L2 vs L4 overlap | Allow an L4 scenario to mirror an L2 scenario | Strict no-duplication rule | L4 with a real SDK can fail in shapes the L2 fake doesn't produce; the duplication is the point. L2 catches seam-shape bugs; L4 catches real-runtime drift. |
| Drop versioned subfolders in this feature | Yes — no `qe-v1` / `qe-v2` subfolders | Mirror Ship's earlier `ship-v1` / `ship-v2` split | Operator preference (session 2026-05-16): the versioned-subfolder framing is being dropped going forward. QE is the first new feature folder to skip it. |

## Engineering decisions

### ED-1 — `docs/features/qe-sdet/` follows the same `spec.md + phases/NN-...md` convention as Ship's feature folders

Reviewers navigate it with the same mental model as a product feature: what's the spec, what's planned, what's in flight. A future cleanup task may migrate the older `ship-v1/phases/04-qe-sdet.md` content into this folder; not blocking and out of scope here.

### ED-2 — Test code is not "secondary"

Per phase 4 § ED-1, `@ship/test-harness` is dev-only. That doesn't make its source secondary. Lint config, comment convention, naming rules, and TS strict knobs apply identically. The PR-sizing rule's 0.5× weight for tests reflects throughput, not bar.

### ED-3 — Per-phase chip queues stay bounded

Phase 9's 8-cap on the P2/P3 chip queue applies to this feature's bug-smash phases too. If a smash session would push the queue past 8, that's signal for a `NNb` follow-up doc, not a longer queue.

### ED-4 — L4 fixtures are repo-scoped, not test-scoped

The existing `e2e/fixtures/test-repo/` is one fixture. New L4 scenarios that need a different fixture shape (e.g. a sandbox repo for live `open_pr`) add a sibling tree (`e2e/fixtures/open-pr-sandbox/`) rather than mutate the existing one. Fixture isolation == scenario isolation.

### ED-5 — Templatability is a first-class goal, not an afterthought

This spec is written so a sibling project (Dossier, Tower, etc.) can copy `spec.md` + the table at § Test-layer taxonomy + the § Philosophy section and get the same conventions for free. Project-specific text lives in the phase docs, not the spec. When phase 02 (mutation) and phase 03 (property-based) draft, their first move is to read whether a portable version of the technique landed elsewhere first.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Feature scope creeps into "all testing problems forever" | Phases stop landing | Hard rule: one technique per phase. The "planned phases" list is the menu; new techniques file a fresh phase doc, not a multi-technique omnibus. |
| L4 expansion burns Cursor + GitHub quota | Cost | Per-phase L4 cap (typically 3–5 scenarios); the `SHIP_LIVE=1` gate keeps default CI free of L4. |
| Mutation testing slow-tail makes CI unusable | Devs disable the gate | Mutation runs nightly only, never on PR CI. Per-package opt-in. Surviving-mutant chips ship through the normal PR flow. |
| Property-based tests flake due to generator non-determinism | False CI failures | Seed the generator deterministically; vitest reporters print the seed on failure so reproduction is trivial. Each property must be deterministic given a fixed seed. |
| Feature folder rots without ownership | Phases stall | Owner is itsHabib until handoff; phases land at the same per-feature cadence as Ship's other recent phases. |
| Templatability claim doesn't survive contact with Dossier | spec.md is overfit to Ship | Phase 02's first action: read this spec.md, identify Ship-isms, propose edits. The spec is allowed to evolve as it touches new projects. |

## Open questions

1. **Should this feature absorb phase 4 + phase 9?** Proposed: no. Those phases are historical artifacts of the earlier feature-folder layout; cross-link, don't migrate. A future doc-cleanup phase can decide otherwise.
2. **Should the test-layer taxonomy live in `CLAUDE.md` instead of here?** Proposed: live here, link from CLAUDE.md. The taxonomy is rich enough that inlining it in CLAUDE.md would bloat the file; the link keeps the index tight.
3. **Should L4 get a nightly CI workflow?** Deferred to phase 01's outcome. If phase 01 lands 4+ L4 scenarios, the nightly workflow file makes sense in its own follow-up phase.
4. **Is `qe-sdet` the right slug?** Considered alternatives: `qe`, `testing`, `hardening`. Kept `qe-sdet` for symmetry with the existing phase 4 title and to read clearly in the folder list.
5. **Should the spec be language-agnostic so it ports to non-TS projects?** Currently it cites vitest / pnpm / Stryker / fast-check. Proposed: keep TS-flavored for Ship + Dossier (both TS); a separate language-agnostic version can fork if a non-TS sibling shows up.

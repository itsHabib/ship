# Phase 03 — Property-based state-machine tests on `@ship/workflow`

Status: design draft, revision 0 (2026-05-16). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-16

> **Companion docs.** [../spec.md](../spec.md) § "Coverage is a floor..." motivates this phase, alongside [phases/02-mutation-testing.md](02-mutation-testing.md). The state machine under test is defined in `packages/workflow/src/transitions.ts` and validated today by the existing unit tests at `packages/workflow/src/transitions.test.ts`. Predecessor: [phases/01-l4-expansion-and-bug-smash.md](01-l4-expansion-and-bug-smash.md) (L4 expansion lands first for visibility on the larger deliverable; this phase doesn't depend on it).

## Scope

**Weighted-LOC budget:**

| Item | Weight | Estimate |
|---|---|---|
| `packages/workflow/src/transitions.properties.test.ts` (incl. inline generators) | 0.5× × ~250 LOC = 125 | core deliverable |
| `packages/workflow/package.json` devDep | 0× | trivial |
| `packages/workflow/README.md` property-tests section | 0× | ~20 LOC docs |
| **Total weighted** | | **~125 LOC** |

Comfortably under "amazing."

**Time budget:** ~3h impl + ~1h tuning.

## Summary

Property-based testing complements (doesn't replace) the hand-written unit tests in `packages/workflow/src/transitions.test.ts`. Hand-written tests assert specific cases ("transition `pending → running` succeeds"). Property tests assert invariants over the state graph ("for all valid `(kind, currentStatus)` pairs, `transition()` either succeeds and produces a status in the documented next-set, or throws a `TransitionError`").

Tool: `@fast-check/vitest`. Generators target the `Phase.kind × Phase.status` Cartesian product; invariants are pulled from the existing state-machine semantics.

Specific invariants tested in this phase:

- **I1** — Every successful transition produces a status in the documented next-set for `(kind, currentStatus)`.
- **I2** — Every terminal-status row (`succeeded` / `failed` / `cancelled`) has `endedAt` set; every non-terminal row has `endedAt` null.
- **I3** — Any sequence of N (≤ 10) valid transitions ends in either a valid state or a `TransitionError`; no other exception type escapes.
- **I4** — Round-trip: a `Phase` row serialized via the Zod schema and parsed back preserves all fields exactly.

## Functional requirements

### F1 — Add `@fast-check/vitest` devDependency

`packages/workflow/package.json`: add `@fast-check/vitest` (transitively pulls `fast-check`). Pin to latest stable.

### F2 — Property test file at `packages/workflow/src/transitions.properties.test.ts`

Uses `test.prop(...)` from `@fast-check/vitest`. One `test.prop` block per invariant (I1–I4). Generators inline at the top of the file:

- `kindArbitrary: fc.Arbitrary<Phase.kind>` — `fc.constantFrom("implement", "open_pr", ...)`.
- `statusArbitrary: fc.Arbitrary<Phase.status>` — `fc.constantFrom("pending", "running", "succeeded", "failed", "cancelled")`.
- `phaseArbitrary: fc.Arbitrary<Phase>` — composed from the above + timestamp generators.
- `transitionSequenceArbitrary: fc.Arbitrary<readonly Phase.status[]>` — `fc.array(statusArbitrary, { maxLength: 10 })` for I3.

Each invariant block has:

- The `test.prop` with the generator(s).
- The invariant assertion.
- An optional `fc.pre(...)` precondition where the invariant only holds under certain inputs.

### F3 — Iteration counts + seed determinism

- Default: 100 iterations per property (fast-check default). Fast enough for `make check`.
- Override for nightly: `SHIP_PROP_ITER=1000` env switch read at file top. Wires through `test.prop({ numRuns: ITER })`.
- Seed: fast-check defaults to a fixed seed per run; on failure, the seed + counterexample print automatically. Reproduction: `vitest --seed=<seed>`.

### F4 — Properties are deterministic given a seed

No `Math.random()`, no `Date.now()`, no clock-dependent assertion. All randomness comes from fast-check's seeded generator. The test runs identically across CI hosts given the same seed.

## Non-functional requirements

- **Hand-written tests remain.** Property tests *supplement* `transitions.test.ts`, not replace. Specific edge cases stay as hand-written assertions for discoverability.
- **No new production source.** Generators are inline in the test file; no new `src/*.ts` outside the test.
- **Coverage thresholds unaffected.** Property tests count as test coverage; the existing 95% statements / 90% branches threshold on `@ship/workflow` should hold or improve.
- **`make check` runtime budget.** 100-iteration property tests typically run in <100ms per file. The package's `make check` time grows by <1s.
- **Property failures gate `make check`.** Unlike mutation (Phase 02), property failures are real bugs — same gate as the existing `transitions.test.ts`.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Tool | `@fast-check/vitest` | `jsverify` (abandoned), raw `fast-check` | The vitest adapter is vitest-native; integrates with existing reporters + config. Raw `fast-check` works but the adapter is more ergonomic. |
| Replace vs supplement hand-written | Supplement | Replace | Hand-written tests document intent (specific scenarios). Property tests stress the general case. Both are valuable; replacing loses discoverability. |
| Generators inline vs separate file | Inline | Separate `generators.ts` | <250 LOC fits inline; single-file is easier to navigate. Extract if a second property test file lands on the same package. |
| Iteration count | 100 default, 1000 nightly opt-in | Fixed 100 always | 100 is fast for PR CI; 1000 catches more rare cases when nightly runtime budget allows. Single env switch makes opt-in cheap. |
| Where: `@ship/workflow` only | Yes | Extend to `@ship/store` / `@ship/core` immediately | Samurai-sword. `@ship/workflow` is the highest-value state-machine target. Other packages get their own phase docs if signal warrants. |
| Property failures gate `make check` | Yes | Advisory | Property tests are unit-level — same gate as the existing `transitions.test.ts`. A property failure is a real bug, not feedback. |
| I3 sequence length cap | 10 | Unbounded | 10 covers every realistic phase lifecycle (pending → running → terminal is 2–3); unbounded would explode the search space without informativeness. |

## Engineering decisions

### ED-1 — `@fast-check/vitest` over raw `fast-check`

The adapter integrates with vitest's reporters and seed-handling. Reporters print `Counterexample: ...` automatically on failure; raw `fast-check` requires manual logging. The adapter is small + well-maintained.

### ED-2 — Generators inline, not extracted

Until a second property test file exists in the same package, extracting generators is premature. Single-file ergonomics win; inline `fc.Arbitrary<...>` builders are typed and discoverable. Extract on the second consumer.

### ED-3 — Seed determinism is mandatory

Property tests with non-deterministic generators can't be reproduced; fast-check defaults to seeded generation but a careless `fc.constant(Date.now())` would break this. The phase doc commits to no clock-dependent generators. Reviewers check this. `SHIP_PROP_ITER` and `vitest --seed=<n>` are the two knobs operators tune.

### ED-4 — Invariants over the state graph, not over individual transitions

The hand-written `transitions.test.ts` already covers individual transitions ("`pending → running` succeeds"). Property tests target the *graph*: invariants that should hold for any sequence of transitions. This is where property-based shines.

### ED-5 — `SHIP_PROP_ITER` env override

`const ITER = Number(process.env["SHIP_PROP_ITER"] ?? 100);` at the top of the test file; `test.prop({ numRuns: ITER }, ...)`. A future nightly CI workflow can set the env to 1000; PR CI uses the default. Phase 02's nightly workflow file is a separate concern; if/when we add a workflow that runs `SHIP_PROP_ITER=1000 make check`, it lands as its own follow-up.

### ED-6 — Property failures print counterexample + seed

`@fast-check/vitest`'s default failure format includes the shrunken counterexample (the smallest input that triggers the failure) and the seed. Reproduction: re-run with `vitest --seed=<seed>` and the failure is deterministic.

### ED-7 — `fc.pre` filters invalid inputs, doesn't throw

When a property only holds under certain inputs (e.g. I1 only applies to valid `(kind, status)` pairs that have a non-empty next-set), use `fc.pre(...)` to skip invalid inputs rather than throw. Discarded inputs count against the fast-check "max skipped" budget; if they exceed it the test errors with a clear message rather than silently passing on too-restrictive generators.

## Validation plan

### Acceptance for the design PR

- This doc reviewed + merged on `main`.

### Acceptance for the impl PR

- `pnpm --filter @ship/workflow test` passes with the new property tests included.
- `make check` from repo root still passes; runtime grows by <1s.
- Coverage on `@ship/workflow` stays ≥95% statements / 90% branches.
- **Deliberate regression check:** introduce an off-by-one in `transitions.ts` (e.g. invert a comparison); verify a property test catches it; revert.

### Acceptance for the practice

- The first month produces zero property-test flakes (deterministic by ED-3).
- If a property fails on a real bug, the counterexample + seed are printed; reproduction is trivial.
- New transitions added to the state machine prompt new properties (reviewer-enforced in PR checklist if signal warrants).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Property test flakes | Discredits the technique | ED-3 + ED-6: seed determinism is mandatory; flake would mean a clock-dependent generator, which the review checklist forbids. |
| Generator coverage gaps | Properties pass but real bugs remain | The state-graph Cartesian product is small (~5 statuses × ~3 kinds = ~15 states); fast-check exhaustively covers it within 100 iterations. Add `fc.constantFrom` over the exact set for the rare path. |
| Runtime growth on `make check` | Devs disable the gate | 100 iterations is fast (<100ms typical); the package's `make check` already runs in <2s. Budget enforced in NF. |
| Properties drift from real state machine | Tests pass while the machine evolves | Each transition added to `transitions.ts` is reviewer-required to add a corresponding property. PR template item if signal warrants. |
| Counterexamples are hard to read | Operator skips investigating | `@fast-check/vitest` shrinks counterexamples to minimal form; the printed value is typically 1-3 lines. ED-6 covers this. |
| Tool maturity (vitest adapter ~1y old) | API churn | Pin minor version via `pnpm`; Renovate / dependabot manage upgrades through review. |
| `fc.pre` filter too restrictive | Test reports too many discarded inputs | ED-7: fast-check errors loudly when the discard budget is exceeded; tighten the generator until the discard rate drops. |

## Out of scope

- **Property tests on `@ship/store`.** SQL hydration has invariants worth fuzzing (e.g. "round-trip preserves all fields"), but each package gets its own phase doc. Follow-up if signal warrants.
- **Property tests on `@ship/core`'s `ShipService`.** Side-effect-heavy code; property testing here would require extensive stubbing. Defer.
- **Replacing the hand-written `transitions.test.ts`.** Per Tradeoffs, supplement not replace.
- **A nightly workflow that sets `SHIP_PROP_ITER=1000`.** ED-5 wires the env; the actual workflow file is a separate follow-up if 1000-iter signal proves valuable.
- **Coverage of `OpenPrService`'s state machine.** The implement-phase + open_pr-phase state machines live in `@ship/workflow`; property tests cover them. The `OpenPrService` orchestration layer is service-test territory.

## Open questions

1. **Should the property test file replace `transitions.test.ts` once the suite is mature?** Proposed: no — keep both. Hand-written tests document intent.
2. **Nightly iteration count (`SHIP_PROP_ITER`) — 1000 or more?** Proposed: 1000 for state graphs of `@ship/workflow`'s size. Raise to 10000 if a real bug only surfaces under high iteration; revisit then.
3. **Add a property for `Phase.endedAt` being monotonically ≥ `Phase.startedAt`?** Currently the state machine doesn't enforce; the store does (timestamps via clock). Decide once Phase 02 (mutation) flags the gap.
4. **Add property tests for `@ship/workflow`'s ID-generation helpers (ULID monotonicity)?** Proposed: defer to a follow-up if useful. Out of this phase's narrow state-machine scope.

## Implementation plan

After this doc is reviewed and merged:

1. **Add devDependency** `@fast-check/vitest` to `packages/workflow/package.json`. Pin to latest stable.
2. **Write `packages/workflow/src/transitions.properties.test.ts`** per F2. Generators inline; one `test.prop` block per invariant (I1–I4).
3. **Verify locally:** `pnpm --filter @ship/workflow test`. Confirm property tests run + pass.
4. **Run with `SHIP_PROP_ITER=1000`** locally to validate the higher-iteration cadence works.
5. **Deliberate regression check** per Validation: introduce + revert an off-by-one in `transitions.ts` to confirm the property catches real bugs.
6. **Update `packages/workflow/README.md`** with a one-liner on property tests + the `SHIP_PROP_ITER` override.

Total weighted LOC: **~125** (one test file + devDep). Wall time: ~3h impl + ~1h tuning.

## Outcome

*Populated after the impl PR merges: number of properties active, deliberate-regression catch confirmation, runtime delta on `make check`.*

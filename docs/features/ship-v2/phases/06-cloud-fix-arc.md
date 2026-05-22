# Phase 06 — cloud-fix arc

Status: ready for impl
Owner: ship (cursor)
Date: 2026-05-21

> Predecessor: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md) + its impl arc (`04-impl-NN-*.md`). Trigger: the first-ever live cloud preflight on 2026-05-21 (`wf_01KS4D2V2J5E7Y65K71ZK14FBC`) surfaced five compound bugs that together make `ship.ship --runtime cloud` non-functional end-to-end. Local runtime is unaffected.

## Scope

**Weighted LOC budget — ~575, "ideal" band across 2 PRs.**

- PR1: ~230 weighted LOC ("amazing" band) — cloud unblock + diagnostic logger.
- PR2: ~345 weighted LOC ("ideal" band) — bug 2/3/4 fix + warnings + L3 regression-guard.

Files this phase touches (cumulative; per-PR file lists in § Implementation plan):

- `packages/core/src/default-wiring.ts` — `PRODUCTION_DEFAULT_THINKING` → `DEFAULT_MODEL`.
- `packages/core/src/service.ts` — `resolveModelSelection`, `thinkingParam`, `mergeThinkingParam`, `tryWriteSuccessArtifacts`.
- `packages/mcp/src/mcp.ts` — `thinkingEffortSchema` delete, `shipInputSchema` gains `modelParams`.
- `packages/cli/src/commands/ship.ts` — `--thinking` delete, `--model-param` add.
- `packages/cursor-runner/src/cloud-runner.ts` — debug log call sites; PR2: explicit `startingRef` forwarding in `cloudAgentOptions`.
- `packages/cursor-runner/src/_shared.ts` — `mapTerminalResult` signature widen (PR2).
- `packages/cursor-runner/src/runner.ts` — `CursorRunResult.warnings` (PR2).
- `packages/cursor-runner/src/debug.ts` (NEW, PR1) — env-var-gated stderr logger.
- `e2e/scenarios/cloud-e2e-helpers.ts` + sister references — **sandbox URL sweep** to canonical `https://github.com/itsHabib/agent-sandbox` (replacing the stale default that no longer exists upstream).
- `e2e/scenarios/cloud-happy-path.e2e.test.ts` + `cloud-auto-create-pr-false.e2e.test.ts` — PR2 regression-guard assertions.
- Test churn: ~30 references for PR1, ~17 for PR2 across `packages/cli/test/`, `packages/core/src/`, `packages/cursor-runner/`, `packages/mcp/src/`, `packages/workflow/src/`.

## Summary

Phase 04 shipped the cloud-runtime code path; the first real invocation surfaced five distinct bugs that share one root: ship's cloud surface is opaque to the operator and we have no diagnostic affordance at the SDK boundary. Bug 1 (model params stale) is the P0 unblock — every cloud run fails at `agent.send` with `[invalid_model]` because cursor's current model catalog has no model accepting a `thinking` param. Bugs 2-4 (`startingRef` / `autoBranch` / `autoCreatePR` all silently ignored) need diagnosis before fix — we don't yet know whether ship is dropping fields, the SDK is stripping them, or the cursor API is ignoring them. Bug 5 (`result.json` doesn't capture cursor's actual git state) is operator visibility.

The arc treats all five as one phase because their fixes touch the same handful of files in `cursor-runner` + `core` and share the same diagnostic prerequisite. PR1 unblocks (model fix) AND ships the diagnostic logger that PR2 needs. PR2 uses PR1's logger evidence to design the actual fix for bugs 2-4, then hardens visibility (warnings field + L3 regression-guard).

## Functional requirements

### F1 — Drop the `thinking` abstraction; callers pass `model` + explicit `params`

After PR1, `ship.ship` no longer accepts a `thinking` field. Callers pass `model: <id>` plus explicit `params: [...]` (or `modelParams: [...]` via the MCP/CLI surface; the CLI gets a repeatable `--model-param key=value` flag mirroring the existing `--cloud-env-var` pattern).

When neither `model` nor `modelParams` is set, ship uses the wiring's `DEFAULT_MODEL` (composer-2.5 + `fast: true` — cursor's own default for that model). When `model` is set but `modelParams` is not, ship sends the model with no params (cursor picks its variant default).

Acceptance: live `mcp__ship__ship --runtime cloud --cloud-repo https://github.com/itsHabib/agent-sandbox` with no model args reaches `agent.send` successfully (was failing with `[invalid_model]`).

### F2 — `SHIP_CLOUD_DEBUG=1` stderr logger

A minimal logger lives at `packages/cursor-runner/src/debug.ts`. When `process.env["SHIP_CLOUD_DEBUG"] === "1"`, the cloud runner emits two log lines per run to `process.stderr`:

- `[ship-cloud-debug] Agent.create payload: <JSON.stringify({cloud, model})>`
- `[ship-cloud-debug] mapTerminalResult result.git: <JSON.stringify(result.git)>`

When the env var is unset (the default in CI and in production runs), the logger short-circuits to a no-op before any work happens — zero behavior change and no perf cost.

**Safety invariant:** `apiKey` MUST NOT appear in any log line. The runner builds the loggable payload separately from the `Agent.create` args (which need `apiKey`). Asserted via unit test.

### F3 — `result.json` carries a `warnings` array for diagnosable mismatches (PR2)

When the runner observes a discrepancy between the requested cloud spec and the terminal `RunResult`, `result.json` carries a `warnings: string[]` field. Status is unchanged (still `succeeded` if cursor reported it). The warnings are operator-facing strings, closed set this phase:

- `"autoCreatePR was requested but result.branches[0].prUrl is undefined"`
- `"autoBranch was requested but result.branches[0].branch is undefined"`
- `"startingRef '<x>' was requested but result.git reports ref '<y>'"` (only when cursor surfaces the actual ref)

Empty warnings field is omitted entirely (no zero-value array in persisted JSON).

### F4 — Sandbox URL alignment

`CLOUD_SANDBOX_REPO_URL` in `e2e/scenarios/cloud-e2e-helpers.ts` and the five onboarding / helper touchpoints called out in PR1 now point at **`itsHabib/agent-sandbox`**, which matches the live GitHub sandbox the operator provisioned (the previous hyphenated repo name was fictional and broke cloud L3).

### F5 — L3 cloud regression-guard against silent "pushed to main" (PR2)

`cloud-happy-path.e2e.test.ts` gains a hard assertion: when `autoCreatePR: true` was requested, `branches[0]` MUST have a non-empty `branch` field AND a non-empty `prUrl` field. Asserts against the **persisted `result.json` read off disk**, not just the parsed stdout — catches divergence between runtime computation and persistence. `cloud-auto-create-pr-false.e2e.test.ts` gains `expect(branches[0].branch).toBeDefined()`.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Model-param abstraction | **Option A — drop `thinking` entirely, callers pass model+params verbatim** | B (per-model adapter mapping `thinking` → `fast`/`reasoning`) / C (hybrid) | Cursor's per-model param vocabulary now varies enough (`fast` on composer, `reasoning` on gpt-5.5, no shared name) that any abstraction is leaky. Samurai-sword: ship doesn't grow a per-model adapter just to preserve a single ergonomic knob. Callers know their model. |
| PR split | **2 PRs (unblock+logger → fix+warnings+guard)** | 1 PR (everything) / 5 PRs (per-bug) | 1 keeps cloud broken until the whole arc ships. 5 over-splits work that's tightly coupled in the runner. 2 captures the only load-bearing dependency: PR1's logger evidence determines PR2's diagnosis. |
| Logger surface | **Env-var-gated `process.stderr.write`, single file, no transport** | Pluggable logger interface / debug package / pino-style structured logging | Samurai-sword: ship has no logging infrastructure today and shouldn't grow one for two log lines. If the logger grows beyond cloud-runner, that's a separate phase. |
| `warnings` placement | **Top-level `CursorRunResult.warnings: string[] \| undefined` (omitted when empty)** | Per-branch warnings / new top-level `diagnostics` object | Cloud's "mismatch" is run-level, not branch-level. Flat top-level array is the simplest legible shape. |
| `warnings` impact on status | **Status unchanged (still `succeeded`)** | New `succeeded-with-warnings` or `degraded` status | Third terminal status forces every downstream caller (CLI formatter, MCP output schema, store schema, ~20 test assertions) to learn it. Operator reads warnings separately. |
| Test churn rollout | **Each PR carries its own test updates** | One bulk "test churn" PR | Splitting tests from production code creates a window where main is red. PR1 carries the bulk (model+param renames). |

## Engineering decisions

### ED-1 — New production default: `composer-2.5 + fast=true`

`PRODUCTION_DEFAULT_THINKING: ThinkingEffort = "high"` in `default-wiring.ts` is deleted. New `DEFAULT_MODEL: ModelSelection = { id: "composer-2.5", params: [{ id: "fast", value: "true" }] }`. Matches cursor's own default variant for composer-2.5.

### ED-2 — `resolveModelSelection` simplified

The new resolver is shape:

```ts
// shape illustration; real impl in PR1
function resolveModelSelection(input: ShipInput, defaultModel: ModelSelection): ModelSelection {
  if (input.model !== undefined) {
    return {
      id: input.model,
      ...(input.modelParams !== undefined && { params: input.modelParams }),
    };
  }
  if (input.modelParams !== undefined) {
    return { id: defaultModel.id, params: input.modelParams };
  }
  return defaultModel;
}
```

`thinkingParam()` and `mergeThinkingParam()` are deleted. No per-model adapter.

### ED-3 — Debug logger never sees `apiKey`

The loggable payload object is built **separately** from the `Agent.create` args that need `apiKey`. The logger receives only the `{cloud, model}` slice. No `JSON.stringify`-on-the-whole-`Agent.create`-args-object, ever. A unit test asserts the string `apiKey` never appears in the logger's output for a realistic input.

### ED-4 — `warnings` derivation runs against the requested cloud spec (PR2)

`mapTerminalResult` widens to `(result, status, requestedCloudSpec | undefined)`. New `deriveCloudWarnings(requestedCloudSpec, result): string[]` helper produces the warnings array. For local runs the third arg is `undefined` and no warnings are derived.

### ED-5 — L3 assertion reads `result.json` from disk

Per the regression-guard requirement, PR2's L3 assertion does a fresh-read of `result.json` from disk (not the parsed stdout from the CLI). This catches the failure mode where ship's runtime CursorRunResult computation differs from what gets persisted — which is the bug 5 symptom.

### ED-6 — `--model-param` parsing mirrors `--cloud-env-var`

The existing `--cloud-env-var <pair>` option in `packages/cli/src/commands/ship.ts` splits on first `=` only, is repeatable, last key wins. `--model-param <key=value>` mirrors this verbatim — no new parsing helper.

### ED-7 — Naming compliance

No `Impl` suffix in symbol names. No `And`/`Or` in function names. Comments `//` only, no JSDoc. Per the operator's naming memory entries.

## Validation

### Per-PR (CI)

- `make check` green (typecheck + lint + format + unit tests).
- `pnpm run coverage` green (per-package coverage thresholds hold).
- ubuntu + windows CI matrix green.

### Arc-level (operator live runs)

- After PR1: live cloud `ship.ship` reaches `agent.send`; `SHIP_CLOUD_DEBUG=1` run captures the `Agent.create` payload trace.
- After PR2: live cloud `ship.ship` with `startingRef` / `autoBranch` / `autoCreatePR` set produces matching cursor behavior — OR `result.json` carries the expected warnings + filed cursor-side issue.

## Risks

| Risk | Mitigation |
|---|---|
| Cursor's model catalog shifts again between PR1 and PR2 | PR1's `DEFAULT_MODEL` is pinned with a comment naming the date the catalog was read. Easy to bump in a future PR. |
| PR1's diagnostic evidence is inconclusive | PR2 still ships — its scope becomes operator-facing escape (e.g. workaround via `autoBranch: false` + explicit `open_pr`) and updates the phase doc Risks. |
| `warnings` field shape leaks into a downstream schema we forgot | PR2 explicitly walks every consumer of `CursorRunResult` (file: `packages/cursor-runner/src/runner.ts`; grep on `CursorRunResult` to enumerate). |
| URL sweep misses a hidden ref | PR1 greps the full repo before the impl; sweep is mechanical sed-equivalent for the 6 known files. |

## Out of scope

1. **Multi-repo cloud runs** — single-repo invariant from phase 04 holds.
2. **General "cursor SDK behaved unexpectedly" error class** — bugs 2-4 are about diagnosing one specific failure cluster.
3. **Cursor-side bug filing** — operator files those out-of-band.
4. **Backfilling `warnings` onto past runs** — new runs only.
5. **Logger upgrades** — pluggable transports, structured logging, per-package loggers. PR1's logger is two stderr lines for one purpose.
6. **Restoring a per-model effort abstraction later** — explicit philosophy: ship doesn't ship cross-model leaky abstractions.

## Implementation plan

### PR1 — cloud unblock + diagnostic logger

**Target: ~230 weighted LOC, "amazing" band.**

1. Delete `PRODUCTION_DEFAULT_THINKING` from `packages/core/src/default-wiring.ts`. Add `export const DEFAULT_MODEL: ModelSelection = { id: "composer-2.5", params: [{ id: "fast", value: "true" }] };` with a `//` comment naming the cursor model-catalog read date.
2. Update `packages/core/src/service.ts:765-815` — delete `thinkingParam()`, `mergeThinkingParam()`. Rewrite `resolveModelSelection` per ED-2.
3. Delete `thinkingEffortSchema` from `packages/mcp/src/mcp.ts`. Update `shipInputSchema`: remove `thinking: thinkingEffortSchema.optional()`, add `modelParams: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) })).optional()`. Remove `ThinkingEffort` from package exports.
4. Update `packages/cli/src/commands/ship.ts` — delete `--thinking` option + `parseThinking()`. Add `--model-param <key=value>` repeatable option (mirror `--cloud-env-var` parsing per ED-6).
5. Verify `packages/workflow/src/workflow.ts` `modelSelectionSchema` accepts the freeform shape (likely no change).
6. Create `packages/cursor-runner/src/debug.ts` with `cloudDebugLog(label, payload)`. Env-var-gated per F2; safety invariant per ED-3.
7. Add 2 call sites in `packages/cursor-runner/src/cloud-runner.ts`: before `Agent.create` (line ~101) log `{cloud, model}`; inside `mapTerminalResult` in `_shared.ts` (line ~18) log `result.git`.
8. URL sweep — normalize every tracked helper/doc reference enumerated in § F4 of the PR1 execution plan to **`itsHabib/agent-sandbox`**, plus remove any leftover references to the legacy hyphenated sandbox segment (\`ship\` + \`-live-\` + \`sandbox\`).
9. Update tests across the 8 affected test files (~30 references). Most mechanical (sed-equivalent). New: 3 logger tests (env-var on/off, apiKey absence).
10. `pnpm run check`. `pnpm run coverage`.
11. Commit as `feat(cloud): drop thinking abstraction + add SHIP_CLOUD_DEBUG logger + URL sweep (phase 06 PR1)` with the Cursor co-author trailer.

### PR2 — bug 2/3/4 fix + warnings + L3 guard

**Target: ~345 weighted LOC, "ideal" band.**

1. **Gather PR1's evidence first.** Read the captured `Agent.create` payload + cursor's `Agent.get` response for the same run. Read `@cursor/sdk` 1.0.12's `CloudAgentOptions` type at `node_modules/.pnpm/@cursor+sdk@1.0.12/node_modules/@cursor/sdk/dist/esm/`.
2. **Diagnose each bug** (2 = startingRef, 3 = autoBranch, 4 = autoCreatePR). Per-hypothesis action: (a) ship-side spread bug → explicit forward in `cloudAgentOptions`; (b) SDK type strips → file upstream + workaround if exists; (c) API ignores → file with cursor + surface via warnings.
3. Patch `packages/cursor-runner/src/cloud-runner.ts:45-58` `cloudAgentOptions(spec)` per the diagnosis.
4. Widen `mapTerminalResult` signature in `packages/cursor-runner/src/_shared.ts` to `(result, status, requestedCloudSpec | undefined)`. Add `deriveCloudWarnings(requestedCloudSpec, result): string[]` helper.
5. Update call sites in `cloud-runner.ts` (pass spec through) and `local-runner.ts` (pass `undefined`).
6. Add `readonly warnings?: readonly string[]` to `CursorRunResult` interface in `packages/cursor-runner/src/runner.ts`.
7. Update L3 scenarios: `cloud-happy-path.e2e.test.ts` adds hard assertion + result.json fresh-read per ED-5; `cloud-auto-create-pr-false.e2e.test.ts` adds branch assertion.
8. Test churn (~17 references): signature updates + 4 new warning-condition tests + 2 new L3 assertions.
9. `pnpm run check`. `pnpm run coverage`.
10. Commit as `feat(cloud): forward startingRef + result.json warnings + L3 regression-guard (phase 06 PR2)` with the Cursor co-author trailer.

## Cross-refs

- Source preflight run: `wf_01KS4D2V2J5E7Y65K71ZK14FBC` (failed Agent.send), then hacked retry succeeded (model: composer-2.5 + fast=true).
- Cursor models catalog probe: `GET https://api.cursor.com/v1/models` (read 2026-05-21).
- Dossier tasks: `tsk_01KS4DA0EY2A74ANKZCHRZZBF1` (closes via PR1), `tsk_01KS4DAY6R6WGVMWMCVES5RH48` (closes via PR2).
- Predecessor: phase 04 ([04-cursor-cloud-runner.md](04-cursor-cloud-runner.md)).

# Phase 06 impl 01 — cloud unblock + diagnostic logger

Status: ready for impl
Owner: ship (cursor)
Date: 2026-05-21

> Parent design: [06-cloud-fix-arc.md](06-cloud-fix-arc.md). This is PR1 of 2.
> Bundles the P0 model-param unblock + the diagnostic logger that PR2 needs.

## Scope

**Weighted LOC budget — ~230, "amazing" band.**

- `packages/core/src/default-wiring.ts` — delete `PRODUCTION_DEFAULT_THINKING`; add `DEFAULT_MODEL` constant.
- `packages/core/src/service.ts` — delete `thinkingParam()`, `mergeThinkingParam()`; simplify `resolveModelSelection`.
- `packages/mcp/src/mcp.ts` — delete `thinkingEffortSchema`; replace `thinking` field with `modelParams` field in `shipInputSchema`; remove `ThinkingEffort` export.
- `packages/cli/src/commands/ship.ts` — delete `--thinking` option + `parseThinking()`; add `--model-param <key=value>` repeatable option.
- `packages/cursor-runner/src/debug.ts` — NEW; env-var-gated stderr logger.
- `packages/cursor-runner/src/cloud-runner.ts` — 2 debug log call sites; verify no other changes needed.
- `packages/cursor-runner/src/_shared.ts` — 1 debug log call site in `mapTerminalResult`.
- `e2e/scenarios/cloud-e2e-helpers.ts` + 5 sister files + related cloud CLI spawns — **sandbox URL sweep** to canonical `https://github.com/itsHabib/agent-sandbox` (replacing stale `CLOUD_SANDBOX_REPO_URL` / doc examples).
- Test churn (~30 references) across `packages/cli/test/ship-command.test.ts`, `packages/core/src/default-wiring.test.ts`, `packages/core/src/service.test.ts`, `packages/cursor-runner/src/local-runner.test.ts`, `packages/cursor-runner/src/model-selection-compat.test.ts`, `packages/cursor-runner/test/cloud-runner.test.ts`, `packages/mcp/src/mcp.test.ts`, `packages/workflow/src/workflow.test.ts`.

## Functional requirements

### F1 — Drop the `thinking` abstraction

After this PR, ship has no `thinking` concept. Callers pass `model: <id>` (optional) plus `modelParams: [...]` (optional). Defaults flow from `DEFAULT_MODEL` in default-wiring.

CLI surface:
- `--model <id>` — already exists; keep.
- `--model-param <key=value>` — NEW; repeatable; split on first `=` only; last key wins. Mirrors existing `--cloud-env-var <pair>` parsing.
- `--thinking <effort>` — DELETE.

MCP surface:
- `shipInputSchema.thinking` — DELETE.
- `shipInputSchema.modelParams` — NEW; `z.array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) })).optional()`.
- `thinkingEffortSchema` export — DELETE.
- `ThinkingEffort` type export — DELETE.

Resolver behavior (new `resolveModelSelection` in `packages/core/src/service.ts`):

```ts
// shape illustration; comments style `//` per repo convention
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

`thinkingParam()` and `mergeThinkingParam()` helpers in service.ts are DELETED. No per-model adapter introduced.

### F2 — `DEFAULT_MODEL = composer-2.5 + fast=true`

In `packages/core/src/default-wiring.ts`:

```ts
// shape illustration
export const DEFAULT_MODEL: ModelSelection = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "true" }],
};
// Read from cursor's GET /v1/models catalog on 2026-05-21. composer-2.5
// is cursor's current default variant; `fast: true` is its isDefault
// param shape. Update both when the catalog rotates.
```

`PRODUCTION_DEFAULT_THINKING` is DELETED. The default-wiring factory that previously injected the thinking param now uses `DEFAULT_MODEL` directly.

The `defaultThinking` override in `DefaultShipServiceOpts` is also DELETED (callers passed `"low"` for e2e harnesses; they now pass a full `defaultModel` override instead — or omit it and accept `DEFAULT_MODEL`).

If the wiring opts already supported a `defaultModel` override, keep it. If not, add one (`readonly defaultModel?: ModelSelection`) so e2e harnesses can downshift cost.

### F3 — `SHIP_CLOUD_DEBUG=1` stderr logger

Create `packages/cursor-runner/src/debug.ts`:

```ts
// shape illustration; real impl uses `//` comments only

const ENABLED = (): boolean => process.env["SHIP_CLOUD_DEBUG"] === "1";

export function cloudDebugLog(label: string, payload: unknown): void {
  if (!ENABLED()) return;
  // stderr write; one line; no trailing newline issues
  process.stderr.write(`[ship-cloud-debug] ${label}: ${JSON.stringify(payload)}\n`);
}
```

Read `process.env["SHIP_CLOUD_DEBUG"]` inside the function (not at module load) so tests can flip it via `process.env` mutation.

Two call sites:

**Site 1 — `packages/cursor-runner/src/cloud-runner.ts` before `Agent.create` (around line 101):**

Build the loggable payload separately from the `Agent.create` args. Do NOT pass `Agent.create`'s args object directly to the logger — that would expose `apiKey`.

```ts
// shape illustration
const cloudOpts = cloudAgentOptions(cloudSpec);
const modelArg = modelArgFromInput(input);
cloudDebugLog("Agent.create payload", { cloud: cloudOpts, model: modelArg });
agent = await Agent.create({
  apiKey,
  cloud: cloudOpts,
  model: modelArg,
  // ... existing optional fields
});
```

**Site 2 — `packages/cursor-runner/src/_shared.ts` inside `mapTerminalResult` (around line 18-29):**

Log `result.git` before constructing the return value.

```ts
// shape illustration
export function mapTerminalResult(
  result: RunResult,
  status: "succeeded" | "cancelled",
): CursorRunResult {
  cloudDebugLog("mapTerminalResult result.git", result.git);
  return {
    branches: result.git?.branches ?? [],
    // ... rest unchanged
  };
}
```

**Safety invariant:** `apiKey` MUST NOT appear in any log line. Add a unit test: build a realistic input with a non-empty `apiKey`, capture logger output, assert the string `apiKey` and any reasonably-shaped key prefix (e.g. `cur_`, `crsr_`) does not appear in the captured stderr.

### F4 — Sandbox URL alignment

Point every enumerated helper / doc reference at **`itsHabib/agent-sandbox`** (HTTPS URL + owner/repo prose). Mechanical copy-edit; no behavioral change to Ship beyond the corrected default URL constant.

Listed paths (six):

- `e2e/scenarios/cloud-e2e-helpers.ts`
- `e2e/scenarios/live-cli-helpers.ts` (was `live-open-pr-helpers.ts` pre-removal of the open_pr verb)
- `e2e/README.md`
- `docs/e2e-execution.md`
- `docs/features/qe-sdet/phases/01-l4-expansion-and-bug-smash.md`
- `docs/features/remove-open-pr/spec.md` (was `docs/features/ship-v2/phases/02-open-pr.md` pre-removal)

Post-merge audit: the tree must not retain the **legacy** sandbox slug spelled by concatenating `ship`, `-live-`, and `sandbox` into one repo segment (the hyphenated name that preceded this PR). Search the workspace excluding `node_modules` / `.git` — expect zero contiguous matches for that obsolete segment.

CLI-spawned cloud scenarios updated in-repo for `--model-param` parity (replacing `--thinking`) ship in the same PR even when not listed explicitly above — same mechanical alignment pass.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Default model | composer-2.5 + fast=true | gpt-5.5 / Auto / composer-2 | composer-2.5 is cursor's newest composer; fast=true is its `isDefault: true` variant per GET /v1/models. Auto (`default` model id) has empty params so it sidesteps the bug but loses the composer/gpt choice — explicit default is more legible. composer-2 still exists in the catalog but composer-2.5 is the upgrade path. |
| `--model-param` value type | `z.union([z.string(), z.boolean()])` | string-only | Cursor's `fast` param takes literal booleans in some SDK call sites; strings work too for the API but matching the SDK's shape preserves the structural-twin invariant per service.ts line 186. |
| Backward compat for `--thinking` flag | Hard delete | Soft-deprecate (accept + warn for one release) | Ship has no released versions; private repo; operator-only consumer. Hard delete keeps the diff clean. |
| Logger gate semantics | Strict `=== "1"` | Truthy check | Matches existing `SHIP_LIVE === "1"`, `SHIP_CLOUD === "1"` pattern in the same package. Consistency over flexibility. |
| Logger output destination | stderr | stdout / file / ring buffer | stderr is the conventional debug-output stream; doesn't interfere with `--json` stdout output. File / ring buffer would grow infrastructure for two log lines. |

## Engineering decisions

### ED-1 — No new symbols use `Impl` suffix; no function name uses `And`/`Or`

Per operator naming memory. The new logger function is `cloudDebugLog` (not `logCloudDebug` or `cloudDebugLogger`). The new resolver is still `resolveModelSelection` (existing). The new constant is `DEFAULT_MODEL` (not `DEFAULT_MODEL_SELECTION`).

### ED-2 — Comments are `//` only, no JSDoc

Per operator memory. New file `debug.ts` uses `//` comments throughout. Existing files with JSDoc are NOT churned (out of scope) — only the new file follows the modern style.

### ED-3 — `modelParams` schema admits string-or-boolean values

The cursor SDK's `ModelParameter.value` is typed as `string`, but the runtime API also accepts booleans for `fast`. Ship's `modelParams` schema accepts both at the boundary; the resolver passes through verbatim. If cursor tightens the API to reject one shape, ship's schema can tighten in a future PR.

### ED-4 — `--model-param` parsing extracts into a small helper

Add `parseModelParam(raw: string): { id: string; value: string | boolean }` in `packages/cli/src/commands/ship.ts` next to `parseThinking`'s former location (which is being deleted). Split on first `=` only. Value is parsed as boolean if it's literal `"true"` / `"false"` (lowercase); otherwise stays as string. Repeatable option accumulates into an array; resolver dedupes last-wins per `id`.

### ED-5 — Logger reads env at call time, not module load

Tests need to flip `SHIP_CLOUD_DEBUG` between cases. Reading the env inside the function (per F3's example) supports this without module reset gymnastics. The perf cost is one env lookup per call — negligible.

### ED-6 — `tryCleanupRemoteBranchOrPr` is NOT touched this PR

Out of scope (it's a PR2 / phase-doc-out-of-scope concern). PR1 leaves the helper alone even though we noted its silent-no-op behavior during diagnosis.

## Validation

- `make check` green (typecheck + lint + format + unit tests).
- `pnpm run coverage` green (per-package thresholds hold).
- Manual probe: render `mcp__ship__ship` schema (via the MCP introspection path or by reading the generated schema doc) — confirm `thinking` field is gone and `modelParams` field is present.
- Manual probe: search the checkout (excluding `node_modules`, `.git`) for the **legacy** hyphenated sandbox repo segment assembled from `ship` + `-live-` + `sandbox`; expect zero contiguous matches post-PR.
- Manual probe: `grep -r "PRODUCTION_DEFAULT_THINKING" packages/` returns zero matches.
- Manual probe: `grep -r "thinkingEffortSchema\|ThinkingEffort\|thinkingParam\|mergeThinkingParam" packages/` returns zero matches (these symbols are gone).

## Risks

| Risk | Mitigation |
|---|---|
| A test file uses `thinking` in a string literal context (e.g. a string assertion) and grep flags a false positive | The test churn list is enumerated by file; iterate per-file and review each match in context. |
| `defaultThinking` opt in `DefaultShipServiceOpts` had downstream callers I missed | Grep for `defaultThinking` across the repo; if any e2e harness still passes it, replace with a `defaultModel` override or drop entirely. |
| `--model-param fast=true` parses `"true"` as a string, but cursor expects literal boolean for some call sites | Per ED-3, the schema accepts both; the resolver passes through. If a runtime conflict surfaces, PR2 (or a chip) tightens. |
| Logger fires during a unit test that didn't expect stderr noise | Tests run with `SHIP_CLOUD_DEBUG` unset by default; gate is strict `=== "1"`. New logger tests explicitly flip the env. |
| URL sweep misses a hidden ref (e.g. inside a markdown code block) | Re-run repo-wide search for the legacy hyphenated sandbox segment (\`ship\` + \`-live-\` + \`sandbox\`); acceptance is zero contiguous occurrences outside archival history. |

## Out of scope

- Bug 2/3/4 fixes (`startingRef` / `autoBranch` / `autoCreatePR`) — that's PR2, which depends on PR1's logger evidence.
- `warnings` field on `result.json` — PR2.
- L3 regression-guard assertions — PR2.
- Logger upgrades (transports, levels, per-package logger) — explicitly out of scope per phase doc.
- Restoring any per-model effort abstraction later — explicit philosophy per phase doc.

## Implementation plan

1. **Delete the thinking abstraction in MCP layer first.**
   - `packages/mcp/src/mcp.ts`: remove `thinkingEffortSchema`; update `shipInputSchema` (remove `thinking`, add `modelParams`); update package exports.
   - `packages/mcp/src/mcp.test.ts`: remove `thinkingEffortSchema` tests; add `modelParams` shape tests.

2. **Update workflow / core layer.**
   - `packages/workflow/src/workflow.ts`: verify `modelSelectionSchema` accepts the freeform shape (likely no change; existing tests cover this).
   - `packages/core/src/default-wiring.ts`: delete `PRODUCTION_DEFAULT_THINKING`; add `DEFAULT_MODEL`; update factory to use it; delete `defaultThinking` opt if no downstream callers (grep first).
   - `packages/core/src/service.ts:765-815`: delete `thinkingParam()`, `mergeThinkingParam()`, simplify `resolveModelSelection` per F1.

3. **Update CLI layer.**
   - `packages/cli/src/commands/ship.ts`: delete `--thinking` option + `parseThinking()`; add `--model-param <key=value>` option + `parseModelParam()` helper.

4. **Add the diagnostic logger.**
   - Create `packages/cursor-runner/src/debug.ts` per F3.
   - Add call site in `cloud-runner.ts` (build loggable payload separately from `Agent.create` args).
   - Add call site in `_shared.ts:mapTerminalResult`.
   - Add unit tests in `cloud-runner.test.ts`: env-var-on emits 2 lines; env-var-off emits 0 lines; `apiKey` absence from output.

5. **URL sweep.**
   - Rewrite the tracked helpers + onboarding docs enumerated in F4 to `itsHabib/agent-sandbox`, then grep the checkout for the legacy hyphenated sandbox segment (\`ship\` + \`-live-\` + \`sandbox\`) with vendor dirs excluded—expect zero matches after PR1 merges.

6. **Test churn.**
   - Walk the 8 affected test files in dependency order (mcp → workflow → core → cursor-runner → cli). Most updates are mechanical (`thinking: "high"` → equivalent `modelParams` array; `composer-2` → `composer-2.5` where literal-pinned). A handful need behavioral rewrites (resolveModelSelection tests).

7. **Validation.**
   - `pnpm run check`.
   - `pnpm run coverage`.

8. **Commit** as `feat(cloud): drop thinking abstraction + add SHIP_CLOUD_DEBUG logger + URL sweep (phase 06 PR1)` with the Cursor co-author trailer.

## Cross-refs

- Parent design: [06-cloud-fix-arc.md](06-cloud-fix-arc.md).
- Source preflight evidence: `wf_01KS4D2V2J5E7Y65K71ZK14FBC` (failed Agent.send with `[invalid_model]`).
- Direct SDK probe confirming valid combos: `GET https://api.cursor.com/v1/models` (read 2026-05-21).
- Dossier task: `tsk_01KS4DA0EY2A74ANKZCHRZZBF1` (model-params).

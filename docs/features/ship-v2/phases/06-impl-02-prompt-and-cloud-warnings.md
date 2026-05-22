# Phase 06 impl 02 — prompt-template cleanup + cloud warnings + L3 regression-guard

Status: ready for impl
Owner: ship (cursor)
Date: 2026-05-22

> Parent design: [06-cloud-fix-arc.md](06-cloud-fix-arc.md). This is PR2 of 2.
> Bundles the rule 6/7 cleanup (root-cause hypothesis for bugs 3+4), two
> phase-05 follow-up chips that touch the same file (rule 8 prefix breadth,
> rule 8 re-validate), defensive per-repo forwarding for `startingRef`, the
> `warnings` field on `result.json`, and the L3 cloud regression-guard.

## Evidence from PR1's `SHIP_CLOUD_DEBUG` logger

Live preflight `wf_01KS6SGCRC3GVVAGB85B7EAS8R` fired 2026-05-22 02:51 UTC against
`itsHabib/agent-sandbox` with `autoCreatePR: true`. The two stderr lines from
PR1's logger:

```
[ship-cloud-debug] Agent.create payload: {"cloud":{"repos":[{"url":"https://github.com/itsHabib/agent-sandbox"}],"autoCreatePR":true},"model":{"id":"composer-2.5","params":[{"id":"fast","value":"true"}]}}
[ship-cloud-debug] mapTerminalResult result.git: {"branches":[{"repoUrl":"github.com/itsHabib/agent-sandbox"}]}
```

Observed behavior — cross-checked against `gh api repos/itsHabib/agent-sandbox/commits`:

- Ship sent `autoCreatePR: true`. Cursor's runtime **ignored it**: no PR opened (`gh api repos/itsHabib/agent-sandbox/pulls?state=open` → length 0).
- Ship did NOT send `startingRef` (the L3 fixture invocation omits the flag). Cursor used cursor's default ref. **Bug 2 isn't reproduced by this preflight** — but the SDK's `CloudAgentOptions.repos[]` does declare `startingRef?: string` (verified at `node_modules/.pnpm/@cursor+sdk@1.0.12/.../options.d.ts:107-111`), so an explicit per-repo forward is cheap defensive insurance against TS structural-typing edge cases that a blind `[...spec.repos]` spread might miss.
- Cursor pushed commit `70219eb8 feat(sandbox): add greet module with vitest scaffold` direct to `agent-sandbox/main` despite the agent's structured summary literally reading *"Changes are committed locally; no push or PR was opened per task instructions"*. Cursor's runtime auto-push machinery fired after the agent's response.
- Ship's `result.branches[0]` has only `repoUrl` — no `branch`, no `prUrl`. From ship's records alone the operator can't tell whether cursor opened a PR, pushed to main, or just committed locally.

Diagnostic conclusions:

1. **Rule 6/7 is the load-bearing constraint surfacing in the agent's structured summary.** Per friction log F8 (2026-05-21), rules 6 (`"Do NOT open a pull request. Ship will handle that as a separate phase."`) and rule 7's last bullet (`"Do NOT push and do NOT open a pull request (the driver owns those)."`) tell cursor not to push or open PRs. Cloud spec's `autoCreatePR: true` tells cursor to do exactly that. Verbose prompt vs single struct field — prompt wins inside the agent's deliberation, even when cursor's runtime auto-push machinery later overrides anyway. Dropping these constraints removes the agent-vs-runtime contradiction and is the most likely fix for bug 4 (and bug 3 by extension — cursor reads "don't push" as also covering branch-creation).
2. **The SDK has no `autoBranch` field on `CloudAgentOptions`.** Prior-session F4's "ship.autoBranch ignored" was a misdiagnosis — there is no field for ship to send. Cursor's runtime has implicit autoBranch behavior server-side; the visible symptom (push-to-main, no branch) is downstream of rule 6/7 winning over the spec. No autoBranch surface to add this PR.
3. **`warnings` is load-bearing for visibility even if rule 6/7 cleanup fixes bugs 3+4 cleanly.** Cursor's runtime can still diverge (push without PR, or PR without branch, or vice versa). Operators need a non-silent signal in `result.json`.
4. **L3 regression-guard prevents the "succeeded silently with push to main" symptom from recurring unseen.** Asserts against the persisted `result.json` from disk, not just parsed stdout.

## Scope

**Weighted LOC budget — ~190, "amazing" band.**

Files this PR touches:

- `packages/core/src/artifacts/prompt-template.ts` — rule 6 delete, rule 7 last bullet swap (`"Do NOT push…"` → draft-clause), rule numbering shifts (rule 7 → 6, 8 → 7, 9 → 8), rule 8 (new 7) prefix-list breadth + re-validate clauses.
- `packages/core/src/artifacts/prompt-template.test.ts` — drop deleted-text assertions, add new draft-clause + rule-8 broadening + re-validate assertions, update rule-number loop bound from 9 to 8.
- `packages/cursor-runner/src/runner.ts` — `CursorRunResult` gains `readonly warnings?: readonly string[]`.
- `packages/cursor-runner/src/_shared.ts` — `mapTerminalResult` signature widens to `(result, status, requestedCloudSpec?)`; new exported `deriveCloudWarnings(spec, result): string[]` helper.
- `packages/cursor-runner/src/cloud-runner.ts` — `cloudAgentOptions` switches `repos: [...spec.repos]` to an explicit per-repo map preserving `startingRef`; both `mapTerminalResult` call sites pass the cloud spec through.
- `packages/cursor-runner/src/local-runner.ts` — `mapTerminalResult` call sites pass `undefined` for the spec (no warnings derivation for local runs).
- `packages/cursor-runner/test/cloud-runner.test.ts` — signature updates at existing call sites, 4 new warning-condition tests, 1 new explicit-startingRef-forwarding test.
- `packages/cursor-runner/src/local-runner.test.ts` — signature updates at existing call sites.
- `packages/cursor-runner/src/fake.test.ts` — signature updates if any direct `mapTerminalResult` calls.
- `packages/core/src/service.test.ts` — signature flow-through if any direct calls (likely none — service constructs `CursorRunResult` literals).
- `e2e/scenarios/cloud-happy-path.e2e.test.ts` — fresh-read `result.json` from disk; hard assertions on `branches[0].branch` and `branches[0].prUrl` when `autoCreatePR: true`.
- `e2e/scenarios/cloud-auto-create-pr-false.e2e.test.ts` — add `expect(branches[0].branch).toBeDefined()`.

Test churn ~17 references; new tests ~50 LOC. Production diff ~75 LOC.

## Functional requirements

### F1 — Prompt rule 6/7 cleanup + renumber

Per friction log F8 and the agent's structured summary verbatim, rule 6 and rule 7's "Do NOT push and do NOT open a pull request" bullet are the load-bearing contradiction with cloud spec's `autoCreatePR: true`. Drop both. Replace the deleted constraint with a softer "if you do push or open a PR, mark it draft" clause inside the existing rule 7 commit block. Renumber rules 7→6, 8→7, 9→8 so the prompt has a clean 1..8 sequence.

**Concrete edits in `prompt-template.ts`:**

Delete the current rule 6 entirely (the line that reads `"6. Do NOT open a pull request. Ship will handle that as a separate phase."`).

Inside the current rule 7's bullet list, replace the last bullet (`"Do NOT push and do NOT open a pull request (the driver owns those)."`) with:

`"If you do push or open a PR, mark the PR as \`--draft\`. The driver promotes from draft to ready when reviewing."`

Renumber the rule prefix on each remaining rule: 7 → 6, 8 → 7, 9 → 8.

Update the cross-reference inside the renumbered rule 7's first sentence: `"After committing (rule 7), consider invoking…"` → `"After committing (rule 6), consider invoking…"`. Same for the sub-bullet skip-guard: `"Skip this rule entirely if rule 7 was skipped"` → `"Skip this rule entirely if rule 6 was skipped"`.

Rule 5's reference to "blocker note per rule 5" stays unchanged (the rule it points to didn't move).

### F2 — Rule 7 (new) follow-up commit prefix breadth

Per dossier task `tsk_01KS0DZ9R854ZQNDX3KG503H3F`. The current wording for the follow-up commit (after rule 7's renumber, the clause inside the new rule 7) says:

> "then make a new second commit (not \`--amend\`) with a \`fix(...)\` or \`refactor(...)\` prefix"

The narrower list is inconsistent with rule 6's (formerly rule 7's) broader Conventional Commit list (`feat(...)`, `fix(...)`, `test(...)`, `docs(...)`, `refactor(...)`). Broaden the new rule 7's prefix wording to: `"with an appropriate Conventional Commit prefix per rule 6 (e.g. \`fix(...)\`, \`refactor(...)\`, \`test(...)\`, \`docs(...)\`)"`.

This is a ~5-LOC clause swap — kept inside this PR rather than as a follow-up chip because it touches the same `prompt-template.ts` lines as F1's renumber.

### F3 — Rule 7 (new) re-validate after follow-up commit

Per dossier task `tsk_01KS0DZXAGAH1W719N0JWBH0K2`. After cursor lands the follow-up commit (rule 7's new wording from F2), the staged checks (`validator` subagent output, if it ran earlier in the pass) are stale against the new commit. Add a clause: after the follow-up commit, **re-invoke `validator`** before proceeding to the structured summary. Conditional on validator having been previously invoked (`"if you previously invoked validator on the pre-fix diff, re-invoke it on the post-fix diff before producing the structured summary."`).

Skip re-invoking `code-reviewer` automatically — the cap-re-run-depth-at-1 tradeoff from the task body keeps the prompt simple.

This is a ~5-LOC addition in the same rule 7 block.

### F4 — Defensive per-repo explicit forwarding for `startingRef`

`packages/cursor-runner/src/cloud-runner.ts:50-63` currently builds `cloudAgentOptions` with `repos: [...spec.repos]` — a blind spread. TS structural typing should preserve `startingRef` since the SDK's `CloudAgentOptions.repos[]` declares it (verified at `node_modules/.pnpm/@cursor+sdk@1.0.12/node_modules/@cursor/sdk/dist/esm/options.d.ts:107-111`). But the cheap defensive move is an explicit per-repo map:

```ts
// shape illustration; real impl in this PR uses `//` comments only
function cloudAgentOptions(spec: CloudRunSpec): CloudAgentOptions {
  return {
    repos: spec.repos.map((r) => ({
      url: r.url,
      ...(r.startingRef !== undefined && { startingRef: r.startingRef }),
      ...(r.prUrl !== undefined && { prUrl: r.prUrl }),
    })),
    ...(spec.workOnCurrentBranch !== undefined && {
      workOnCurrentBranch: spec.workOnCurrentBranch,
    }),
    ...(spec.autoCreatePR !== undefined && { autoCreatePR: spec.autoCreatePR }),
    ...(spec.skipReviewerRequest !== undefined && {
      skipReviewerRequest: spec.skipReviewerRequest,
    }),
    ...(spec.envVars !== undefined && { envVars: spec.envVars }),
    ...(spec.env !== undefined && { env: spec.env }),
  };
}
```

Preserves `prUrl` too (also on the SDK's repo shape, for resume-into-existing-PR flows — defensive even though not exercised this PR).

The matching test in `cloud-runner.test.ts` asserts that when a spec carries a per-repo `startingRef`, the constructed `Agent.create` args include it on `cloud.repos[0].startingRef`.

### F5 — `warnings: string[]` on `CursorRunResult`

`CursorRunResult` gains `readonly warnings?: readonly string[]` immediately after `branches`. Omitted entirely when empty (no zero-value array in persisted JSON; matches existing pattern for `summary`, `errorMessage`).

`packages/cursor-runner/src/_shared.ts` adds an exported helper:

```ts
// shape illustration
export function deriveCloudWarnings(
  spec: CloudRunSpec | undefined,
  result: RunResult,
): string[] {
  if (spec === undefined) return [];
  const out: string[] = [];
  const branch = result.git?.branches?.[0];
  if (spec.autoCreatePR === true && (branch?.prUrl === undefined || branch.prUrl === "")) {
    out.push("autoCreatePR was requested but result.branches[0].prUrl is undefined");
  }
  if (spec.workOnCurrentBranch !== true && (branch?.branch === undefined || branch.branch === "")) {
    out.push(
      "a new branch was expected (workOnCurrentBranch !== true) but result.branches[0].branch is undefined",
    );
  }
  const requestedRef = spec.repos[0]?.startingRef;
  const reportedRef = result.git?.ref;
  if (
    requestedRef !== undefined &&
    requestedRef !== "" &&
    reportedRef !== undefined &&
    reportedRef !== "" &&
    requestedRef !== reportedRef
  ) {
    out.push(
      `startingRef '${requestedRef}' was requested but result.git reports ref '${reportedRef}'`,
    );
  }
  return out;
}
```

`mapTerminalResult` signature widens to accept the spec:

```ts
export function mapTerminalResult(
  result: RunResult,
  status: "succeeded" | "cancelled",
  requestedCloudSpec?: CloudRunSpec,
): CursorRunResult {
  const warnings = deriveCloudWarnings(requestedCloudSpec, result);
  return {
    branches: result.git?.branches ?? [],
    ...(warnings.length > 0 && { warnings }),
    durationMs: result.durationMs ?? 0,
    ...(result.model !== undefined && { model: result.model }),
    status,
    ...(result.result !== undefined && { summary: result.result }),
  };
}
```

The third argument is optional so existing local-runner call sites still typecheck. Cloud-runner's two `mapTerminalResult` call sites — one in `mapCloudRunResult` (which currently calls through `mapRunResult`) and the inline `mapTerminalResult(result, "cancelled")` for the expired-status branch — pass the cloud spec through. Local-runner doesn't pass it (warnings stay an empty array → field is omitted from the persisted JSON).

Status is unchanged. `succeeded` runs with non-empty `warnings` are still `succeeded`. No new terminal status.

### F6 — L3 cloud regression-guard

`e2e/scenarios/cloud-happy-path.e2e.test.ts` — when the scenario fires `ship.ship` with `autoCreatePR: true`, the post-run assertion freshly reads `result.json` from disk (using the artifact path on the run record, not the parsed stdout) and asserts:

- `branches[0].branch` is a non-empty string.
- `branches[0].prUrl` is a non-empty string and starts with `https://github.com/`.

If either fails the test fails loudly with both the captured `result.branches[0]` JSON and the persisted `warnings` array (if present) in the failure message, so the operator can read the divergence directly from CI logs without re-running.

`e2e/scenarios/cloud-auto-create-pr-false.e2e.test.ts` — adds `expect(branches[0].branch).toBeDefined()` and `expect(branches[0].branch.length).toBeGreaterThan(0)`. The existing `prUrl === undefined` assertion stays.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| PR2 scope | **Bundle rule 6/7 cleanup + rule 8 breadth/re-validate chips + cloud warnings + L3 guards + defensive forwarding** | Split rule-8 chips into their own PR | All three prompt-template changes touch the same file; bundling avoids merge-order ceremony, one test pass, one CI cycle. Total still in "amazing" band. |
| Rule renumbering | **Renumber 7→6, 8→7, 9→8 after deleting rule 6** | Keep numbering with a gap (5, 7, 8, 9) | Gapped numbering is unconventional and confusing. Mechanical update; tests pin numbers via a loop so the update is one literal change. |
| `warnings` derivation location | **Pure helper in `_shared.ts`, exported** | Inline inside `mapTerminalResult` / private helper | Pure helper unit-tests cleanly without constructing a full RunResult through mapTerminalResult; export lets cloud-runner reuse if ever needed elsewhere. |
| `mapTerminalResult` signature | **Optional third arg (`requestedCloudSpec?: CloudRunSpec`)** | New function `mapTerminalCloudResult` for the cloud variant | Optional arg keeps the single function name (avoids touching 4 existing call sites' call shape) and lets local-runner stay verbatim with no third-arg pass. |
| `startingRef` forwarding | **Explicit per-repo map (defensive)** | Leave the blind `[...spec.repos]` spread | Cheap insurance (~3 LOC). PR1's payload doesn't exercise startingRef so we can't prove the spread is fragile, but the explicit map removes the ambiguity for free. |
| Re-invoke `code-reviewer` in rule 7 | **No — re-invoke `validator` only** | Re-invoke both | Cap re-run depth at 1 per the task body's tradeoff. Re-running code-reviewer can chain (reviewer finds something on the fix-of-the-fix → another commit → another re-review). Validator's check-runs-or-not is a clean terminating signal. |
| L3 assertion source | **Fresh-read `result.json` from disk** | Use parsed stdout from the ship CLI | Per ED-5 of the parent design — catches the case where ship's runtime CursorRunResult computation differs from what gets persisted. |

## Engineering decisions

### ED-1 — `warnings` is `readonly string[] | undefined` on the interface, omitted from JSON when empty

`CursorRunResult.warnings?: readonly string[]`. The conditional spread `...(warnings.length > 0 && { warnings })` in `mapTerminalResult` ensures the field is omitted from the persisted JSON when empty, matching the existing pattern for `summary` / `errorMessage`. No zero-value `[]` in `result.json`.

### ED-2 — `deriveCloudWarnings` reads `result.git.ref` defensively

The SDK's `RunResult.git` is `{ branches?: ..., ref?: string }` (the cloud variant). `result.git?.ref` may be undefined when cursor doesn't surface the actual ref — the startingRef warning fires only when both the requested ref AND the reported ref are non-empty strings. No false positives when cursor's response shape varies.

### ED-3 — No `autoBranch` field added to `CloudRunSpec`

The SDK's `CloudAgentOptions` has no `autoBranch` field (verified at `options.d.ts:96-120`). Cursor's runtime has implicit autoBranch behavior server-side. Ship can't influence it via a spec field. The branch-undefined symptom is surfaced via the warning derived from `workOnCurrentBranch !== true && branch === undefined`.

### ED-4 — Naming compliance per operator memory

- No `Impl` suffix on new symbols. Helper is `deriveCloudWarnings`, not `deriveCloudWarningsImpl`.
- No `And`/`Or` in function names. The helper is `deriveCloudWarnings` (not `deriveCloudWarningsAndAssert` or `deriveAndValidate`).
- `//` comments only, no JSDoc on the new helper / new test functions.

### ED-5 — Cloud-runner's two `mapTerminalResult` call paths both receive the spec

`packages/cursor-runner/src/cloud-runner.ts` calls `mapTerminalResult` via two paths:

1. The inline `mapTerminalResult(result, "cancelled")` for the expired-status branch (line 84 in current state).
2. `mapRunResult(result, input)` → which internally calls `mapTerminalResult(result, "succeeded")` or `mapTerminalResult(result, "cancelled")` (in `_shared.ts:mapRunResult`).

For path 1: change to `mapTerminalResult(result, "cancelled", cloudSpec)` and thread `cloudSpec` through `mapCloudRunResult`'s signature.

For path 2: `mapRunResult` widens to accept the optional spec and pass it through. `mapErrorResult` stays unchanged (no warnings derived for failed runs — the error message is the operator's signal).

`packages/cursor-runner/src/local-runner.ts` calls `mapRunResult(result, input)` with no spec — local runs never derive warnings.

### ED-6 — L3 fresh-read uses the run-record artifact path

`cloud-happy-path.e2e.test.ts` already constructs / queries the `WorkflowRun` to get `artifacts.resultPath`. Use that field to `readFile` + `JSON.parse` the persisted artifact, rather than re-parsing the CLI's stdout. The two should be identical; asserting against the disk artifact catches divergence between the runtime computation and the persistence step.

### ED-7 — `prUrl` field on the per-repo spec is also explicitly forwarded

`CloudRunSpec.repos[0].prUrl` (used for resume-into-existing-PR flows) is also threaded through the explicit map in F4. Currently not exercised by any L3 scenario, but the SDK shape declares it, and the explicit forward is the same ~1 LOC pattern as `startingRef`.

## Validation

### Per-PR (CI)

- `make check` green (typecheck + lint + format-check + unit tests).
- `pnpm run coverage` green (per-package thresholds hold).
- ubuntu + windows CI matrix green.

### Per-feature smoke tests added in this PR

- `_shared.test.ts` (new or extended): 4 cases for `deriveCloudWarnings`: (a) spec undefined → returns `[]`; (b) `autoCreatePR: true` + branch with undefined `prUrl` → returns the autoCreatePR warning; (c) `workOnCurrentBranch !== true` + branch with undefined `branch` → returns the branch warning; (d) `startingRef` set + `result.git.ref` set to a different value → returns the ref-mismatch warning.
- `cloud-runner.test.ts`: assert that `Agent.create` receives `cloud.repos[0].startingRef` when the spec carries it (covers F4).
- `cloud-runner.test.ts`: assert that a `succeeded` mapped result with the autoCreatePR-but-no-prUrl pattern carries the `warnings` field with the expected entry, and that the persisted JSON shape contains the field at the top level.

### Arc-level (post-merge operator validation)

- Operator fires a fresh cloud preflight with `autoCreatePR: true` + `--cloud-starting-ref ship-l3-fixture`. Expected outcomes:
  - If rule 6/7 cleanup fixed bugs 3+4: cursor opens a real PR as `--draft`; `result.json.branches[0].branch` and `prUrl` are populated; no warnings fire.
  - If cursor's runtime still ignores the spec: `warnings` array in `result.json` flags the divergence; operator files a cursor-side issue.
- `result.git.ref` matches the requested `startingRef` (or the startingRef warning fires).

## Risks

| Risk | Mitigation |
|---|---|
| Renumbering touches every rule line; one stray reference (e.g. inside a comment or test description) gets missed | The test pins rule numbers via a `for n=1..N` loop AND has explicit cross-reference assertions ("Skip this rule entirely if rule 6 was skipped" — was rule 7). Both must update together. Grep the codebase for `rule [6-9]` and `rule \\\\d` patterns post-impl. |
| `mapTerminalResult` signature change breaks a downstream caller not enumerated | Optional third arg keeps existing call sites compiling. Type system catches the rest. |
| `deriveCloudWarnings` false-positives a warning when cursor's `result.git.branches[0].branch` is legitimately undefined (e.g. workflow ran but produced no commits to a branch) | The `workOnCurrentBranch !== true` gate scopes the warning to runs that explicitly expected a branch. If a future code path runs cloud with no branch expected, set `workOnCurrentBranch: true` and the warning is suppressed. |
| L3 regression-guard fails CI when cursor's cloud is itself down / flaky (not a ship regression) | The L3 cloud scenarios are gated on `SHIP_LIVE=1 SHIP_CLOUD=1`. CI doesn't run them by default. Operator runs them manually as part of the validation step. |
| Rule 6/7 cleanup doesn't actually fix bugs 3+4 (cursor's runtime override stands regardless) | The `warnings` field surfaces the divergence so it's not silent. PR3 (deferred this phase) would file with cursor + add operator-facing escape hatches (e.g. `autoCreatePR: false` + explicit `open_pr`). |

## Out of scope

1. **Adding `autoBranch` to `CloudRunSpec`** — SDK has no such field (per ED-3).
2. **Multi-repo cloud runs** — single-repo invariant from phase 04 holds.
3. **Filing the cursor-side bug** for the autoCreatePR-ignored behavior (operator action, post-validation).
4. **Backfilling `warnings` onto past `result.json` files** — new runs only; `undefined` is the absence sentinel.
5. **Re-invoking `code-reviewer` in rule 7 (new)'s re-validate clause** — kept simple per the tradeoff above.
6. **`.cursor/agents/` shell-portability docs chip** — task `tsk_01KRWAARYYBEXXFYD1122P17NK`. Touches different files; ships as a separate follow-up commit / PR after PR2.
7. **Cloud-VM subagent loading bug** — preflight v3's structured summary noted that repo-registered subagents (`code-reviewer`, etc.) weren't in the task tool enum. Separate concern; file as a chip after PR2 lands.
8. **Logger upgrades** — explicitly out of scope per phase doc.

## Implementation plan

1. **Prompt-template surgery.**
   - In `packages/core/src/artifacts/prompt-template.ts`:
     - Delete the current rule 6 line entirely.
     - In the current rule 7's bullet list, replace the last bullet (`"Do NOT push and do NOT open a pull request (the driver owns those)."`) with the draft-clause from F1.
     - Renumber: rule 7 → 6, rule 8 → 7, rule 9 → 8.
     - In the new rule 7 (was 8): update `"After committing (rule 7)"` → `"After committing (rule 6)"`; update `"Skip this rule entirely if rule 7 was skipped"` → `"Skip this rule entirely if rule 6 was skipped"`.
     - In the new rule 7's follow-up commit clause: replace `"with a \`fix(...)\` or \`refactor(...)\` prefix"` with `"with an appropriate Conventional Commit prefix per rule 6 (e.g. \`fix(...)\`, \`refactor(...)\`, \`test(...)\`, \`docs(...)\`)"` (per F2).
     - In the new rule 7's success path: add a new clause for the validator re-invoke (per F3). Place it right after the follow-up-commit clause and before the P2/P3-routing clause. Conditional wording: *"If you previously invoked `validator` on the pre-fix diff, re-invoke it on the post-fix diff before producing the structured summary. Skip if you didn't invoke validator earlier in this run."*

2. **Prompt-template tests.**
   - In `packages/core/src/artifacts/prompt-template.test.ts`:
     - Update the rule-number loop bound: `for (let n = 1; n <= 9; n += 1)` → `for (let n = 1; n <= 8; n += 1)`.
     - Drop the `expect(out).toContain("Do NOT open a pull request");` assertion (line 36 in current file).
     - Add new assertions: `expect(out).toContain("mark the PR as \`--draft\`");` (F1's draft-clause).
     - Add new assertions: `expect(out).toContain("appropriate Conventional Commit prefix per rule 6");` (F2's prefix breadth).
     - Add new assertions: `expect(out).toContain("re-invoke it on the post-fix diff");` (F3's re-validate clause).
     - Update the "Skip this rule entirely if rule 7 was skipped" assertion: change `rule 7` → `rule 6`.
     - Update inline comments mentioning rule numbers (`"covers #6 (no PR), #7 (commit)…"`) to reflect the new mapping.

3. **`CursorRunResult.warnings` field + `deriveCloudWarnings` helper.**
   - In `packages/cursor-runner/src/runner.ts`: add `readonly warnings?: readonly string[]` to `CursorRunResult` (immediately after `branches`, before `errorMessage`).
   - In `packages/cursor-runner/src/_shared.ts`: add the `deriveCloudWarnings(spec, result)` export per F5.
   - In `packages/cursor-runner/src/_shared.ts`: widen `mapTerminalResult` signature to `(result, status, requestedCloudSpec?: CloudRunSpec)`; derive warnings inside the function; spread `warnings` conditionally into the return per F5.
   - In `packages/cursor-runner/src/_shared.ts`: widen `mapRunResult` to accept the optional spec; pass it through to `mapTerminalResult`. `mapErrorResult` stays untouched (no warnings on failed runs).
   - In `packages/cursor-runner/src/cloud-runner.ts`: `mapCloudRunResult` accepts `input.cloud` (the cloud spec); pass it through both `mapTerminalResult` (inline expired path) and `mapRunResult` (normal path).
   - In `packages/cursor-runner/src/local-runner.ts`: `mapRunResult` call stays without the spec — local runs derive no warnings.

4. **Defensive per-repo forwarding for `startingRef`.**
   - In `packages/cursor-runner/src/cloud-runner.ts`: rewrite `cloudAgentOptions` per F4. Explicit `.map` over `spec.repos` instead of `[...spec.repos]`.

5. **Tests for `deriveCloudWarnings`.**
   - Extend `packages/cursor-runner/src/_shared.test.ts` (or create if it doesn't exist) with the 4 cases from § Validation.

6. **Cloud-runner tests.**
   - In `packages/cursor-runner/test/cloud-runner.test.ts`: update existing `mapTerminalResult` call-site signatures.
   - Add an `Agent.create` assertion that `cloud.repos[0].startingRef` is forwarded when the spec carries it.
   - Add a warnings-in-result assertion: build a fake `RunResult` with `branches: [{repoUrl: "..."}]` (no branch, no prUrl), build a cloud spec with `autoCreatePR: true`, assert the mapped `CursorRunResult.warnings` contains the autoCreatePR warning.

7. **Local-runner tests.**
   - In `packages/cursor-runner/src/local-runner.test.ts`: update `mapTerminalResult` / `mapRunResult` call-site signatures (most should be unaffected since they didn't pass a spec).

8. **L3 regression-guard.**
   - In `e2e/scenarios/cloud-happy-path.e2e.test.ts`: per F6, freshly read `result.json` from disk via the run record's `artifacts.resultPath`. Assert `branches[0].branch` and `branches[0].prUrl` are non-empty.
   - In `e2e/scenarios/cloud-auto-create-pr-false.e2e.test.ts`: add the branch-defined assertion per F6.

9. **Validation.**
   - `pnpm run check`.
   - `pnpm run coverage`.

10. **Subagents.**
   - After the production + test diff is staged, invoke the repo-registered subagents per rule 7 (new) of the prompt template — `code-reviewer`, `scope-tracker`, `test-author`, `validator`. Address any P0/P1 findings with a follow-up commit per the updated rule (broadened prefix list — `fix` / `refactor` / `test` / `docs` as appropriate).

11. **Commit.**
   - Single commit per ship's usual convention. Conventional Commit subject: `feat(cloud): prompt-template cleanup + result.json warnings + L3 regression-guard (phase 06 PR2)`. Cursor co-author trailer.

## Cross-refs

- Parent design: [06-cloud-fix-arc.md](06-cloud-fix-arc.md)
- Predecessor impl: [06-impl-01-cloud-unblock.md](06-impl-01-cloud-unblock.md)
- Source preflight evidence: `wf_01KS6SGCRC3GVVAGB85B7EAS8R` (2026-05-22; rogue commit `70219eb8` on `agent-sandbox/main`).
- Friction log: `pers/workbench-friction.md` § 2026-05-21 F8 (rule 6/7 hypothesis).
- Dossier tasks closing via this PR:
  - `tsk_01KS4DAY6R6WGVMWMCVES5RH48` — startingRef + autoBranch + autoCreatePR (via warnings + rule 6/7 cleanup + defensive forward).
  - `tsk_01KS0DZ9R854ZQNDX3KG503H3F` — rule 8 prefix breadth (F2).
  - `tsk_01KS0DZXAGAH1W719N0JWBH0K2` — rule 8 re-validate (F3).
- Cursor SDK shape: `node_modules/.pnpm/@cursor+sdk@1.0.12/node_modules/@cursor/sdk/dist/esm/options.d.ts:96-120` (`CloudAgentOptions` interface).

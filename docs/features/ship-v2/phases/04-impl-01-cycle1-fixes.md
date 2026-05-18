# Phase 04 impl PR #1 — cycle-1 fixes

Status: ready-to-ship — input to `ship.ship` to fix cycle-1 bot findings on PR #51.
Owner: itsHabib (driving), cursor (executing)
Date: 2026-05-18

> **Companion docs.** Parent impl task doc: [04-cursor-cloud-runner-impl-01-skeleton.md](04-cursor-cloud-runner-impl-01-skeleton.md). Parent design: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md). PR #51 carries the impl already committed at `b4bc019`; cycle-1 bot review surfaced three actionable issues + one CI gate failure.

## Scope

**~20 src + ~150 tests (0.5×) = ~95 weighted LOC.** Trivially "amazing."

This PR is additive on top of `b4bc019` — adds tests + small fixes; does NOT re-architect anything from PR #51.

## Goal

Address the three cycle-1 issues so PR #51 turns green and merges cleanly:

1. **P1 — case-insensitive `EXPIRED` mapping** (codex bot, line 61 of `cloud-runner.ts`).
2. **P2 — defensive guard for empty `cloud.repos`** (codex bot, line 74 of `cloud-runner.ts`).
3. **CI coverage gate** — `cloud-runner.ts` is at 62.68% coverage; CI's `pnpm run coverage` enforces a 90% global threshold and is failing. Add pipeline / cancel / error / onEvent-promise tests modeled on `local-runner.test.ts` patterns.

## Functional requirements

### F1 — `mapCloudRunResult` accepts uppercase OR lowercase `EXPIRED`

`packages/cursor-runner/src/cloud-runner.ts:61` currently reads:

```ts
if ((result.status as string) === "expired") {
```

Change to case-insensitive:

```ts
if (((result.status as string) ?? "").toLowerCase() === "expired") {
```

Reason (per parent design § ED-5 + codex P1): the SDK's `RunResult.status` documentation uses uppercase `EXPIRED` for cloud, but the typings omit it as of 1.0.x. Casing in practice is currently unknown. Lowercasing the LHS makes the guard robust to either casing.

Add a test in `packages/cursor-runner/test/cloud-runner.test.ts` mirroring the existing `'SDK status "expired" maps to cancelled terminal result'` test but with `status: "EXPIRED"` (uppercase). Both should produce the same `cancelled` terminal.

### F2 — `CloudCursorRunner.run` guards empty `cloud.repos`

`packages/cursor-runner/src/cloud-runner.ts:69-82` currently checks `input.cloud === undefined` but accepts a defined-but-empty `repos` array.

Add a new typed error in `packages/cursor-runner/src/errors.ts`:

```ts
/** Cloud inputs passed to {@link CloudCursorRunner} with an empty `cloud.repos` array. */
export class EmptyCloudReposError extends CursorRunFailedError {
  override readonly name: string = "EmptyCloudReposError";

  constructor() {
    super("cloud.repos must contain exactly one repo entry; received an empty array");
  }
}
```

In `CloudCursorRunner.run`, after the existing `MissingCloudSpecError` throw, add:

```ts
if (input.cloud.repos.length === 0) {
  throw new EmptyCloudReposError();
}
```

Add a test in `cloud-runner.test.ts` (alongside the runtime-guard tests):

```ts
test("throws EmptyCloudReposError when cloud.repos is empty", async () => {
  const runner = new CloudCursorRunner();
  await expect(
    runner.run({
      cwd: "/x",
      model: { id: "composer-2" },
      onEvent: vi.fn(),
      prompt: "x",
      runtime: "cloud",
      cloud: { repos: [] } as unknown as CloudRunSpec,  // bypass tuple typing for runtime test
    }),
  ).rejects.toBeInstanceOf(EmptyCloudReposError);
  expect(Agent.create).not.toHaveBeenCalled();
});
```

Note: `CloudRunSpec.repos` is typed as a single-element tuple, so TS-correct callers can't pass `[]`. The runtime guard is the safety net for MCP / non-TS callers (the cycle-1 codex finding called this out specifically).

### F3 — Push `cloud-runner.ts` coverage above 90%

Current state (from CI run 26011313261): `cloud-runner.ts` 62.68% lines / 60% functions / 68.29% branches. Global threshold is 90%.

Uncovered ranges include 247-252 (`#tryWait` helper), 255-261 (`isPromiseLike` helper), plus pipeline branches (stream success, cancel paths, error handling).

Mirror the test patterns from [packages/cursor-runner/src/local-runner.test.ts](../../../../packages/cursor-runner/src/local-runner.test.ts) (598-line file with comprehensive pipeline coverage; copy structure and adapt for cloud). The tests to add — names should match local-runner's where possible:

1. **`happy path: finished → succeeded, summary = result.result, durationMs preserved`** — full stream + wait + terminal happy path. Pass `events: [SDK message]` so `safelyEmit` fires.
2. **`error → failed; result resolves (does NOT throw); errorMessage populated`** — `result.status: "error"` with `result.result` populated → `errorMessage = result.result`.
3. **`error without RunResult.result → falls back to a generic errorMessage`** — `status: "error"` without `result.result` → generic message.
4. **`cancelled → cancelled; summary preserved if SDK populated it`** — `status: "cancelled"` with `result.result` populated.
5. **`branches preserved from RunResult.git`** — `result.git: { branches: [...] }` populates `CursorRunResult.branches`. Cloud-specific value (unlike local where it's always empty).
6. **`onEvent throws are swallowed; the run still resolves to its terminal status`** — sync throw in onEvent doesn't break the run.
7. **`async onEvent rejection is swallowed`** — onEvent returns a rejected promise; unhandled-rejection trap is the test (mirror local-runner.test.ts pattern).
8. **`stream errors but wait() recovers with a terminal RunResult`** — `streamThrows: <error>`, mocked `wait` returns a terminal. Exercises `#tryWait`.
9. **`stream errors AND wait() rejects → CursorRunFailedError`** — both streamThrows and waitThrows set.
10. **`run.wait() rejects after a clean stream → CursorRunFailedError`** — clean stream, waitThrows set.
11. **`cancel before terminal: status=cancelled, sdkRun.cancel invoked`** — wire `signal` with abort controller, abort mid-stream, assert cancel was called.
12. **`cancel after terminal: no-op`** — call `handle.cancel()` after the run resolves, assert no SDK cancel call.
13. **`cancel-after-cancel: idempotent`** — call `handle.cancel()` twice quickly, assert single SDK cancel call.
14. **`SDK cancel rejection allows retry`** — first cancel rejects (e.g. transient), second cancel succeeds. Cursor's existing code resets `cancelInitiated = false` on cancel rejection.

That's a lot but each test is ~10-25 LOC. Total addition: ~250-350 LOC of tests (0.5× weighted = 125-175). Should push cloud-runner.ts to >95% coverage easily.

If after writing tests you find some specific branches still uncovered, add targeted tests for them.

### F4 — Verify CI coverage gate locally before declaring done

After the impl: run `pnpm run coverage` (not just `make check`) and confirm:

- All tests pass.
- `cloud-runner.ts` coverage > 90% on lines / functions / branches / statements.
- Global coverage > 90%.

The Acceptance criteria in this PR's commit message must reflect `pnpm run coverage green`, not just `make check green` (the original task doc oversight).

## Out of scope (this PR)

- Restructuring `cloud-runner.ts` — the existing structure is fine; we're just adding tests + small guards.
- Refactoring `_shared.ts` — it's at 100% lines / 81.25% branches; the 25, 35-36 branch coverage gap is minor and likely picked up by the new tests anyway.
- `runner.ts` shows 0% in the coverage report — that's because it's type-only and v8 doesn't run it. Don't add tests there.

## Acceptance

- `pnpm run coverage` green locally with `cloud-runner.ts` > 90%.
- All new tests pass.
- Both cycle-1 bot findings addressed (P1 + P2).
- Diff stays under 500 weighted LOC.
- Commit message: `docs(cursor-runner): cycle-1 fixes for CloudCursorRunner skeleton` or similar feat(...) framing; include the cursor co-author trailer.

## Implementation plan

1. Edit `cloud-runner.ts` for F1 (case-insensitive) + F2 (empty-repos guard).
2. Edit `errors.ts` to add `EmptyCloudReposError`.
3. Edit `cloud-runner.test.ts` to add the F1, F2, and F3 test cases. Model on `local-runner.test.ts`.
4. Run `pnpm run coverage` in `packages/cursor-runner` and confirm > 90%.
5. Commit + push.
6. Done — the parent driver will post the cycle-1-addressed comment and re-ping bots.

## Notes for the impl agent

- Cursor's previous run on this same worktree (commit `b4bc019`) shipped the skeleton. The Agent.create call, error wrappers, and pipeline structure are all in place — just need fixes + tests.
- `MockRun` / `makeMockRun` / `makeMockAgent` patterns are already in `cloud-runner.test.ts`; reuse them and grow opts as needed (e.g. for `streamThrows` / `waitThrows` / `events` arrays).
- The `unhandled-rejection` trap pattern (test #7 — async onEvent rejection swallowed) is detailed in `local-runner.test.ts` around line 393; copy it verbatim and adjust the runner class.

# Phase 04 impl 04 — L3 cloud scenarios

Status: ready for impl
Owner: ship (cursor)
Date: 2026-05-18

> Parent design: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md) (PR #50). Predecessor impls: PR #51 (`CloudCursorRunner` skeleton, 2026-05-18), PR #52 (`ShipService` routing + MCP schema + handler re-parse, `ba4d48e`), PR #53 (CLI flags `--runtime`/`--cloud-*`/`--cloud <json>`, `6a63484`).

## Scope

**Weighted LOC budget — ~60, "amazing" band.**

- `e2e/scenarios/cloud-happy-path.e2e.test.ts` — `autoCreatePR: true` flow.
- `e2e/scenarios/cloud-auto-create-pr-false.e2e.test.ts` — `autoCreatePR: false` flow.
- `e2e/scenarios/cloud-cancel-during-creating.e2e.test.ts` — cancel-during-`CREATING` edge case.

All three scenarios gated on **`SHIP_LIVE=1 + SHIP_CLOUD=1 + CURSOR_API_KEY`** — they won't run in CI without the operator-side cloud key. The double gate is intentional per the parent design § Validation: cloud runs cost both Cursor credits and real GitHub branches.

## Summary

Phase 04's impl arc (#51 → #52 → #53) has delivered the cloud-runtime code path end-to-end: a `CloudCursorRunner` class, `ShipService` routing, MCP schema validation, CLI flags. This PR closes the design's § Validation L3 commitment with three live e2e scenarios that exercise the cloud surface against a real Cursor cloud agent.

The scenarios live as `*.e2e.test.ts` files under `e2e/scenarios/` so the existing `e2e/vitest.config.ts` picks them up when `SHIP_LIVE=1`. Each top-level `describe` uses `describe.skipIf(!HAS_KEY_AND_CLOUD)` to no-op in default `pnpm test` runs.

## Functional requirements

### F1 — Cloud happy path with `autoCreatePR: true`

Scenario: spawn `tsx packages/cli/src/bin.ts ship <doc> --runtime cloud --cloud-repo <test-repo-url> --cloud-auto-create-pr --json` against an isolated tmpdir. Assert:

- Ship exits 0.
- Parsed `ShipOutput.status === "succeeded"`.
- `cursorRun.branches[0].branch` is a non-empty string.
- `cursorRun.branches[0].prUrl` is a non-empty string and resolves to a real PR on the test repo (verified via `gh api repos/<owner>/<repo>/pulls/<n>` with the parsed PR number).

**Cleanup (finally):** when the assertions pass, close the PR and delete the cloud-pushed branch on the sandbox repo. Errors during cleanup don't fail the test (best-effort).

### F2 — Cloud `autoCreatePR: false`

Scenario: same shape as F1 but flag drops the `--cloud-auto-create-pr` opt-in. Assert:

- Ship exits 0.
- Parsed `ShipOutput.status === "succeeded"`.
- `cursorRun.branches[0].branch` is a non-empty string.
- `cursorRun.branches[0].prUrl` is `undefined`.

The "explicit `open_pr` against the cloud branch" path is deferred to the follow-up phase (per phase doc § F4); this scenario just verifies the partial-mode persists correctly today.

**Cleanup (finally):** delete the cloud-pushed branch on the sandbox repo (no PR to close).

### F3 — Cancel during `CREATING`

Scenario: spawn ship as in F1, attach `startEventTailer` (from `e2e/scenarios/event-tailer.ts`) to observe `events.ndjson`. When the first cloud `status` event lands (which will be `CREATING` per phase doc § F9), fire `ship cancel <wf-id>` via a separate child process. Assert:

- Ship exits 0.
- Parsed `ShipOutput.status === "cancelled"`.
- The Cursor side has no orphan agent — verify via `Agent.list({ runtime: "cloud" })` (imported from `@cursor/sdk`), filtering to agents whose `agentId` matches the run we cancelled. The list either omits the agent (cancellation fully cleaned up) or shows it in a terminal state (`CANCELLED` / `EXPIRED`).

If the SDK behavior is ambiguous (e.g. CREATING-phase cancel doesn't propagate cleanly) and the assertion fails, leave a `TODO(cloud-spec)` comment with the actual observed behavior so the next iteration of the doc can update § F9 / Risks.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Test placement | Under `e2e/scenarios/` alongside existing live scenarios | New `e2e/scenarios/cloud/` subdirectory | Three files don't warrant a subdirectory. The `cloud-*` filename prefix is enough indexing. |
| Live-gate composition | `SHIP_LIVE=1 + SHIP_CLOUD=1 + CURSOR_API_KEY` triple AND | `SHIP_CLOUD=1` alone (implies live) | Triple AND matches the parent design's stated gate exactly and stays consistent with the existing `hello-world.e2e.test.ts` pattern (`HAS_KEY` constant). |
| Sandbox repo source | Constant URL at file top + comment naming the sandbox repo | Env var (`SHIP_CLOUD_REPO`) | One sandbox repo per test environment is fine. Operator can edit the constant if their sandbox lives elsewhere. Env var would obscure the canonical fixture. |
| Cleanup mode | Best-effort in `finally`; swallow cleanup errors | Hard-fail on cleanup failure | Cleanup failure shouldn't mask the actual test outcome. Manual cleanup via `gh pr close` is the escape hatch. |

## Engineering decisions

### ED-1 — No new test fixtures

The cloud agent operates against a **remote** test repo via `--cloud-repo <url>`, not against a local fixture. No `e2e/fixtures/` additions required.

### ED-2 — Import `@cursor/sdk` directly in the e2e file

`@ship/cursor-runner` has an import-isolation invariant (V1 phase 05 ED-2) saying only it imports `@cursor/sdk`. That invariant doesn't apply to `e2e/` — it's outside any package. The cancel scenario imports `Agent` from `@cursor/sdk` directly for the orphan check.

### ED-3 — Cancel-during-CREATING uses a non-stdout signal

`hello-world.e2e.test.ts` waits for the child process to exit. For cancel-during-`CREATING`, that won't work — we have to fire the cancel command while the child is still alive. Use `startEventTailer` to observe `events.ndjson`; on the first `status: "CREATING"` event, fire `ship cancel <wf-id>` via `runCli` (synchronous helper), then await the child's exit.

If `event-tailer.ts` doesn't already surface the first event in a way the test can `await` on, lift a small helper inside this scenario file rather than adding a generic helper to `event-tailer.ts` — keep the changes scoped.

## Validation plan

### Local validation

- `make check` green locally (without live env vars set, scenarios are skipped).
- `pnpm run coverage` green (same).
- Manually verify the `describe.skipIf(!HAS_KEY_AND_CLOUD)` pattern correctly skips: run `pnpm test` without `SHIP_LIVE=1 SHIP_CLOUD=1` and confirm zero invocations of the cloud surface.

### CI validation

- ubuntu + windows runners pass without firing any cloud scenarios (the gate keeps them off the test path in CI).

### Live validation (operator-side, not blocking this PR)

- One full cloud run against the sandbox repo with `SHIP_LIVE=1 SHIP_CLOUD=1 CURSOR_API_KEY=... pnpm vitest run e2e/scenarios/cloud-happy-path.e2e.test.ts`. Captures the evidence for phase-level acceptance ("One Ship-on-Ship cloud run lands ... and is recorded as evidence in the final impl PR's description").

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `SHIP_CLOUD` env-var name conflicts with another tool | Test gate fires when operator didn't intend | Unlikely; `SHIP_CLOUD` is Ship-specific. Use `SHIP_CLOUD_RUNNER` if conflict surfaces later. |
| Cancel-during-CREATING SDK behavior is broken / undefined | Scenario 3 fails | Document the actual behavior in a `TODO(cloud-spec)` comment; ship the scenario anyway so the next investigation has a starting point. Phase doc § F9 already flagged this as ambiguous. |
| Sandbox repo gets polluted with test branches | Operator has to clean up | Best-effort `finally` cleanup. If accumulation is a real problem, follow up with a GitHub workflow on the sandbox repo to nuke `tower/live-e2e-*` branches older than 24h. |

## Out of scope

- CI runners that actually run the scenarios (cost concern).
- Cloud-runtime variants of the existing local scenarios (`hello-world`, `idempotent-open-pr`, etc.). Three cloud-specific scenarios is enough coverage to validate the new code path.
- L3 scenarios for the follow-up `open_pr cloud-aware` phase (lives with that phase).

## Implementation plan

1. **`pnpm install`** in the worktree.
2. Compute the live-gate const at each file's top: `const HAS_LIVE = process.env["SHIP_LIVE"] === "1" && process.env["SHIP_CLOUD"] === "1" && (process.env["CURSOR_API_KEY"] ?? "") !== "";`.
3. Write `cloud-happy-path.e2e.test.ts`: pattern after `hello-world.e2e.test.ts`'s spawn + stdout-capture + parsed-JSON-assertion; add `--runtime cloud --cloud-repo <url> --cloud-auto-create-pr` to the argv.
4. Add PR-URL verification via `gh api` (use `execFileSync` to spawn `gh` synchronously after the ship run terminates).
5. Add `finally` cleanup: close the PR + delete the branch via `gh pr close --delete-branch`.
6. Write `cloud-auto-create-pr-false.e2e.test.ts`: same shape but drop `--cloud-auto-create-pr` and assert `prUrl === undefined`.
7. Write `cloud-cancel-during-creating.e2e.test.ts`: pattern after `cancel-live-ship.e2e.test.ts`'s `spawnShipChild` + `waitForEventsNdjsonPredicate` + post-cancel-status flow; replace the predicate with one that fires on a `status: "CREATING"` event in `events.ndjson`. Add the `Agent.list({ runtime: "cloud" })` orphan check.
8. Run `pnpm run coverage` locally with the gate UNSET — confirm scenarios skip cleanly and coverage stays green.
9. Run `make check` locally — confirm green.
10. Commit + push.

## Acceptance

- `make check` green on ubuntu + windows CI (without firing any cloud scenarios — gate prevents).
- `pnpm run coverage` green.
- Three new files build / lint / format-check.
- Diff stays under 500 weighted LOC ("amazing" band).
- Commit trailer per `@ship/cursor-runner` convention.

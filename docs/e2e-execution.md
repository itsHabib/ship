# E2E execution

How to run Ship's end-to-end test suite against real Cursor agents + a real GitHub sandbox.

Date: 2026-05-18

## Why this doc

Ship has four layers of testing (see [`docs/features/qe-sdet/spec.md`](features/qe-sdet/spec.md) for the full L1–L4 taxonomy):

| Layer | What | Where | When it runs |
|---|---|---|---|
| **L1** | Pure unit tests | `packages/**/src/**/*.test.ts` | Every `make check` (~600+ tests) |
| **L2** | Integration tests with FakeCursor | `packages/test-harness/scenarios/*.scenario.test.ts`, `packages/core/src/service.test.ts` | Every `make check` |
| **L3** | Live e2e against real SDK + local cursor | `e2e/scenarios/*.e2e.test.ts` (non-cloud), gated `SHIP_LIVE=1 + CURSOR_API_KEY` | Operator-run; CI skips by default |
| **L4** | Live e2e against real SDK + cursor cloud + real GitHub | `e2e/scenarios/cloud-*.e2e.test.ts` (gated `SHIP_LIVE=1 + SHIP_CLOUD=1 + CURSOR_API_KEY + GITHUB_TOKEN`) + `cancel-live-ship.e2e.test.ts` (gated `SHIP_LIVE=1 + CURSOR_API_KEY + GITHUB_TOKEN + SHIP_E2E_SANDBOX_REPO` via `hasLiveEnv()` — no `SHIP_CLOUD` required) | Operator-run; cost real money + leave artifacts on GitHub |

CI runs L1 + L2 on every push (ubuntu + windows). L3/L4 stay opt-in because they consume Cursor credits, push branches to a real GitHub repo, and leave PRs behind. Cleanup is best-effort in `finally` blocks but not guaranteed.

This doc covers how to run L3 + L4 locally when verifying a phase or chasing a real-world regression. L1/L2 are documented inline in `CLAUDE.md` (`make check`).

## Pre-flight setup

### 1. Cursor API key

Get one from `cursor.com/dashboard/api-keys`. Export in your shell:

```sh
export CURSOR_API_KEY=cur_...
```

The key must have access to whatever runtime you're targeting (local-only keys exist; cloud requires a key tied to an account that has cloud enabled).

### 2. GitHub token

Required for any L4 scenario that pushes a branch or opens a PR. Either:

- A classic PAT with `repo` scope, OR
- A fine-grained token scoped to your sandbox repo with `Contents: read+write`, `Pull requests: read+write`

```sh
export GITHUB_TOKEN=ghp_...
```

The token's identity becomes the author of the test PRs and pushed commits.

### 3. Sandbox repo

A throwaway GitHub repo where the e2e suite pushes branches and opens PRs. Required by all L4 scenarios. Properties:

- Empty (the suite force-pushes a fixture as `main`)
- Public OR private (must match `GITHUB_TOKEN`'s scope)
- You own it OR have admin (the suite deletes branches it creates)
- **Do not point this at a production repo.** Branches get force-pushed; PRs get auto-closed.

Set the slug in env:

```sh
export SHIP_E2E_SANDBOX_REPO=itsHabib/agent-sandbox  # owner/repo, no protocol
```

The cloud L3 scenarios currently hardcode `https://github.com/itsHabib/agent-sandbox` (in `e2e/scenarios/cloud-e2e-helpers.ts` — `CLOUD_SANDBOX_REPO_URL`). Update that constant for your sandbox or run against the operator's.

### 4. `gh` CLI

The cloud scenarios use `gh api` for PR verification + cleanup. Either `gh auth login` interactively or rely on `GITHUB_TOKEN` (gh reads `GH_TOKEN` / `GITHUB_TOKEN` automatically when set).

```sh
gh auth status   # confirms gh can resolve a token
```

### 5. Gates

Each tier has its own env-var gate. The full table:

| Var | L3 (local cursor) | L3/L4 (cloud) |
|---|---|---|
| `SHIP_LIVE=1` | required | required |
| `CURSOR_API_KEY` | required | required |
| `GITHUB_TOKEN` | not used | required |
| `SHIP_E2E_SANDBOX_REPO` | not used | required for `cancel-live-ship`; hardcoded in cloud helpers for cloud scenarios |
| `SHIP_CLOUD=1` | — | required |

Scenarios skip cleanly (via `describe.skipIf(...)`) when their gates aren't set — they don't fail.

## Running the suite

The e2e config (`e2e/vitest.e2e.config.ts`) excludes `e2e/**` from the default `vitest run` (so `make check` never sees them). To run them, point vitest at the e2e config explicitly (from the repo root):

```sh
pnpm exec vitest run --config e2e/vitest.e2e.config.ts
```

Or run a single scenario:

```sh
pnpm exec vitest run --config e2e/vitest.e2e.config.ts e2e/scenarios/cloud-happy-path.e2e.test.ts
```

The 5-minute `testTimeout` in the e2e config covers the slowest scenarios (live cancel + 120s predicate waits). All commands below assume the repo root as cwd.

### Run the local-cursor L3 suite (~3 min, 1 cursor credit)

```sh
export SHIP_LIVE=1
export CURSOR_API_KEY=cur_...
pnpm exec vitest run --config e2e/vitest.e2e.config.ts hello-world subagent-invocation
```

Covers:
- `hello-world.e2e.test.ts` — basic ship→cursor→succeeded path against the fixture repo
- `subagent-invocation.e2e.test.ts` — phase-03 subagent passthrough

### Run the live cancel scenario (~3 min, 1 partial cursor credit)

```sh
export SHIP_LIVE=1
export CURSOR_API_KEY=cur_...
export GITHUB_TOKEN=ghp_...
export SHIP_E2E_SANDBOX_REPO=owner/your-sandbox
pnpm exec vitest run --config e2e/vitest.e2e.config.ts cancel-live-ship
```

Covers:
- `cancel-live-ship.e2e.test.ts` — cancel an in-flight run, assert terminal `cancelled`

### Run the cloud L3 suite (~5-10 min, 3 cursor cloud credits + 3 GitHub branches)

```sh
export SHIP_LIVE=1
export SHIP_CLOUD=1
export CURSOR_API_KEY=cur_...
export GITHUB_TOKEN=ghp_...
pnpm exec vitest run --config e2e/vitest.e2e.config.ts cloud-happy-path cloud-auto-create-pr-false cloud-cancel-during-creating
```

Covers (all in `e2e/scenarios/cloud-*.e2e.test.ts`):

| Scenario | What | Cost |
|---|---|---|
| `cloud-happy-path` | `--runtime cloud --cloud-auto-create-pr`; assert branch + prUrl in `result.json`; verify PR via `gh api`; cleanup PR + branch | 1 cloud credit, 1 PR (auto-closed) |
| `cloud-auto-create-pr-false` | `--runtime cloud` without auto-PR; assert branch set, prUrl undefined | 1 cloud credit, 1 branch (auto-deleted) |
| `cloud-cancel-during-creating` | cancel before `RUNNING`; assert terminal `cancelled`; orphan-agent check via `Agent.list({ runtime: "cloud" })` | 1 partial cloud credit |

Cloud sandbox URL is hardcoded in `cloud-e2e-helpers.ts` — edit that constant to point at your sandbox before running.

### Run everything

```sh
export SHIP_LIVE=1 SHIP_CLOUD=1
export CURSOR_API_KEY=cur_... GITHUB_TOKEN=ghp_...
export SHIP_E2E_SANDBOX_REPO=owner/your-sandbox
pnpm exec vitest run --config e2e/vitest.e2e.config.ts
```

Budget ~10-15 min wall + ~6 cursor credits (2 local + 1 partial cancel + 3 cloud) + several throwaway branches/PRs.

## Cleanup

Every scenario tries to clean up its own artifacts in `finally`. Failures can leave residue:

- **Orphan branches on the sandbox repo.** List them: `gh api repos/$SHIP_E2E_SANDBOX_REPO/branches --jq '.[].name' | grep -E '^(cloud-l3|live-e2e|tower/cloud)'`. Delete: `gh api -X DELETE repos/$SHIP_E2E_SANDBOX_REPO/git/refs/heads/<branch>`.
- **Open PRs on the sandbox.** `gh pr list --repo $SHIP_E2E_SANDBOX_REPO`; close with `gh pr close <n> --repo $SHIP_E2E_SANDBOX_REPO --delete-branch` (the `--repo` flag is required — without it `gh` targets the current repo and may close an unrelated PR or fail outright).
- **Orphan cloud agents.** `Agent.list({ runtime: "cloud" })` from a node REPL with `CURSOR_API_KEY` set, or via `cursor.com/dashboard/agents`. Archive/delete from the dashboard or via `Agent.archive(...)`.
- **Local tmpdirs.** Each spawn uses `mkdtempSync(tmpdir(), "ship-...-")`. Most are cleaned in `finally`, but a crashed run can leave them under `$TMPDIR/ship-*` (Windows: `%TEMP%`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Test skips silently when you expected it to run | Gate env var unset; check the test's `describe.skipIf(...)` predicate | `printenv \| grep -E 'SHIP_\|CURSOR_\|GITHUB_'` and confirm everything required for that scenario is set |
| `git push` fails with `Repository not found` | `SHIP_E2E_SANDBOX_REPO` points at a repo `GITHUB_TOKEN` doesn't have write access to | Re-issue the token with `Contents: read+write` on the sandbox, or swap to a sandbox you own |
| `Cursor SDK reported error without a message` in `events.ndjson` | Usually a shell tool-call timeout inside cursor's loop (a long `pnpm run check; pnpm run coverage` chained in one call) OR transient SDK network blip | Inspect `<runs-dir>/<wf>/events.ndjson` for the last `tool_call` — was a long shell in flight? If so, split the chained command in the task doc. Re-run if it looks transient |
| `IntegrationNotConnectedError` from cloud agent | The Cursor account hasn't connected its GitHub integration | Visit `cursor.com/dashboard/integrations/github` — the URL is also embedded in the wrapped `CursorCloudIntegrationError.helpUrl` |
| Sandbox repo accumulates `cloud-l3-cncl-*` branches | Cancel scenario's branch cleanup is best-effort; cloud agent may push *after* cancel race | Run the cleanup `gh api -X DELETE` command above |
| `make check` passes locally but L3 fails with TS errors | `e2e/` isn't in the workspace TS project — `tsc --noEmit` covers it via the e2e `tsconfig.json`; if changes touched a shared interface, also run `pnpm -r run typecheck` | Confirm `pnpm exec tsc --noEmit -p e2e/tsconfig.json` is clean before pushing |

## Cost ceiling

Rough costs per full L4+cloud sweep:

- ~6 cursor credits (2 local + 1 partial cancel + 3 cloud; cloud credits count heavier)
  - L3 local: 2 (hello-world + subagent-invocation, 1 ship each)
  - L4 live cancel: 1 partial (cancel-live-ship)
  - L3 cloud: 3 (cloud-happy-path + cloud-auto-create-pr-false + partial cloud-cancel-during-creating)
- 1-2 PRs on the sandbox (auto-closed; cloud-happy-path opens one via `autoCreatePR`)
- 4-6 branches pushed and deleted
- ~10-15 min wall

If you're iterating on a single scenario, run just that one via the path-suffix arg shown above. The full sweep is for "before merge of a major cursor-runner change" verification.

## When to add a new scenario

Two cases:

1. **A new feature lands** that's hard to L2-fake. Cloud runtime was the canonical example: the fake gives you the routing assertion but not the actual `Agent.create({ cloud })` round-trip. New scenarios live in `e2e/scenarios/<feature>.e2e.test.ts` with the appropriate `describe.skipIf(...)` gate.
2. **A bug got past L1/L2** because the fake didn't model the real SDK behavior. File an L3 to pin the regression.

Naming convention: `<feature-or-flow>.e2e.test.ts`. Add a gate combination that's the minimum env required (don't gate on `GITHUB_TOKEN` if the scenario never touches GitHub). Add a row to the scenario table above.

## Cross-refs

- Test taxonomy: [`docs/features/qe-sdet/spec.md`](features/qe-sdet/spec.md)
- Shared live-CLI helpers: [`e2e/scenarios/live-cli-helpers.ts`](../e2e/scenarios/live-cli-helpers.ts)
- Shared cloud helpers: [`e2e/scenarios/cloud-e2e-helpers.ts`](../e2e/scenarios/cloud-e2e-helpers.ts)
- Event tailer (real-time agent output during a live run): [`e2e/scenarios/event-tailer.ts`](../e2e/scenarios/event-tailer.ts)
- Phase 04 § Validation L3 (the cloud scenarios this doc is principally about): [`docs/features/ship-v2/phases/04-cursor-cloud-runner.md`](features/ship-v2/phases/04-cursor-cloud-runner.md)

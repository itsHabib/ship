# Phase 02 — `open_pr` phase + MCP tool

Status: design draft, revision 1 (2026-05-15). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-15

> **Companion docs.** [spec.md](../spec.md) § Planned V2 phases item 2 seeds this phase. [phases/01-async-ship-tool.md](01-async-ship-tool.md) is the predecessor V2 phase — it changed `ship`'s return contract; this phase introduces the first net-new `Phase.kind`. [ship-v1/spec.md § F1](../../ship-v1/spec.md) defines the V1 `Phase` row this phase composes onto. The PR sizing rule in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:** docs-only for this PR. **0× weighted.** "Amazing" band trivially.

The follow-up implementation PR's preliminary budget: ~120 src (`@ship/workflow` schema bump + `GhClient` interface + `NodeGhClient` impl + `createOpenPrService` + MCP handler + CLI subcommand) + ~330 tests (0.5×) = ~285 weighted LOC. Comfortably inside "amazing." Documented here so the impl PR's scope is visible at design-review time; not binding on this doc-only PR.

## Summary

V2 phase 01 made `ship` callable from an agent without falling out of the MCP request budget. The natural next step in the agent-driven workflow is **opening a PR for the run's branch**. V1 punted this entirely — agents shipped a doc, but the "push the branch + `gh pr create`" step was a manual shell-out the operator ran after `ship` resolved.

This phase introduces a new `Phase.kind = "open_pr"` and a new MCP tool `open_pr` that, given a `workflowRunId`, pushes the run's branch and opens a PR via `gh pr create`. The result is recorded as a new `Phase` row on the existing `WorkflowRun` — composing on V1's schema, no migration.

The tool is **synchronous on the MCP boundary** (unlike `ship`): `gh pr create` plus a branch push is sub-second on the happy path, well inside the MCP request budget. The cursor-agent-style long-running pattern from phase 01 doesn't apply here. CLI mirror is a thin `ship open_pr <workflowRunId>` subcommand for humans.

This is the smallest V2 surface after phase 01 that composes the agent-driven loop one step further: ship → open_pr. Phases 03 (review) and 04 (ci_fix) consume the PR url this phase persists.

## Functional requirements

### F1 — `open_pr` MCP tool opens a PR for a workflow run's branch

Input shape (`openPrInputSchema` — see ED-3):

```ts
{
  workflowRunId: WorkflowRunId,            // required — anchors to an existing run
  base?: string,                            // override the PR's base branch; default below
  title?: string,                           // override the derived title (ED-5)
  body?: string,                            // override the derived body (ED-5)
  draft?: boolean,                          // default false; passes `--draft` to gh
}
```

Output shape (`openPrOutputSchema` — see ED-3):

```ts
{
  workflowRunId: WorkflowRunId,
  phaseId: PhaseId,
  prNumber: number,
  prUrl: string,
  base: string,                             // resolved base branch
  head: string,                             // the workflow run's branch name
  alreadyExisted: boolean,                  // true when the branch already had an open PR (ED-4)
  status: "succeeded",                      // narrowed; impl always returns terminal succeeded
}
```

Tool handler ordering:

1. Validate input against `openPrInputSchema`.
2. Call `OpenPrService.openPr(input)` — see ED-1 for the service-layer placement.
3. Validate output against `openPrOutputSchema`.
4. Return.

On failure inside `openPrService`, the `Phase` row reflects the failure status; the MCP tool returns `isError: true` with the mapped message (V1 mapping pattern from phase 8).

### F2 — `Phase.kind = "open_pr"` extends the V1 `Phase` enum

The `Phase` row already carries `kind`, `status`, `result.json`, and timestamps. This phase adds one new `kind` value and one new `result.json` shape (see ED-2). No schema migration — the existing `phases` SQL table admits new `kind` values without ALTER (per spec.md § ED-1).

The phase row's state machine mirrors the V1 implement-phase machine:

```
pending → running → succeeded
                  ↘ failed
                  ↘ cancelled
```

The `cancelled` transition fires when the run is cancelled via `cancel_workflow_run` while `open_pr` is in flight (sub-second window in practice — see Risks).

### F3 — Preconditions on the workflow run

`openPr` rejects with a typed error when, **in this order**:

1. `workflowRunId` doesn't resolve to a `WorkflowRun` row → `WorkflowRunNotFoundError` (V1 type, reused).
2. The run's implement phase is not `succeeded` → `ImplementPhaseNotSucceededError` (new). Opening a PR for a run whose implementation failed or was cancelled doesn't make sense in V1 — the branch may have partial commits, or no commits at all. If a later phase needs this (e.g. "open a PR even on partial implementation for a human to inspect"), it composes via a new flag rather than relaxing the precondition here.
3. The run's recorded `workdir` is not a git checkout → `WorkdirNotGitError` (new). Cheap pre-flight; surfaces before any push attempt.
4. **Idempotency check runs here** (before the next two errors) — if an open PR already exists for the head/base pair, return it (see F5). Ordering matters: a run whose branch became empty against base (e.g. commits cherry-picked into base) but already has an open PR must still resolve via the idempotent path, not throw `EmptyBranchError`. The check is one `gh pr list` call against the branch + resolved base.
5. The branch recorded on the run has no commits ahead of the resolved base **and** no existing open PR was found in step 4 → `EmptyBranchError` (new). Matches what `gh pr create` would do on its own, but we surface a typed error before the shell-out so the caller distinguishes "nothing to PR" from "gh failed."

Preconditions are checked **before** the `Phase` row is created (per ED-2). A failed precondition (steps 1, 2, 3, or 5) produces no phase row, mirroring V1's "pre-row validation throws cleanly with no row created" rule from phase 01 § F1. The idempotency hit in step 4 *does* create a phase row in `succeeded` directly — it's a successful resolution, not a precondition failure.

### F4 — Sync MCP tool: no async return contract

Unlike phase 01's `ship`, `open_pr` is synchronous on the MCP boundary. The tool handler awaits `OpenPrService.openPr(...)` and returns the full output shape. Justification:

- Happy-path latency is dominated by one `git push` (typically < 500ms over LAN) + one `gh pr create` (typically < 1s). Total wall-clock is comfortably under the ~60s MCP request budget — even on a saturated CI box.
- No analog to the cursor-run's 90–200s long tail exists for `gh pr create`. The async-return pattern would add ceremony without a measurable benefit.
- Cancellation is uninteresting at this latency: the cancel signal would land after the push completes in nearly every realistic case (see Risks).

If a future change makes `open_pr` substantially slower (e.g. multi-repo coordination), revisit the contract under its own phase doc. The MCP tool boundary is the right place to make that change later; the `OpenPrService` method shape is unaffected.

### F5 — Idempotent re-open returns the existing PR

If the run's branch already has an **open** PR against the resolved base, `openPr` returns its `prNumber` / `prUrl` with `alreadyExisted: true` and writes a `Phase` row in `succeeded` state. No second PR is opened. This makes the tool safe to retry from an agent that lost track of whether it already called.

The idempotency check fires **before** the empty-branch precondition (F3 step 4 vs step 5). This matters in a real edge case: an agent calls `open_pr`, the PR is opened, and then someone cherry-picks the branch's commits into base. The branch is now "empty" against base in the `git log` sense, but the PR is still open. A second `open_pr` retry must return the existing PR, not throw `EmptyBranchError`. Inverting the order would silently violate the retry-safe contract.

A **closed** or **merged** PR for the same branch does not block opening a new one — that's the V1 behavior of `gh pr create` and it matches operator expectations (re-running `open_pr` after a merged PR opens a fresh PR for new commits on the same branch). The `alreadyExisted` flag covers the "open" case only.

Detection uses `gh pr list --head <branch> --base <base> --state open --json number,url --jq '.[0]'`. The detection is one extra `gh` invocation; the latency is invisible compared to the create itself.

## Non-functional requirements

- **Backwards-compatible at the data layer.** No SQL schema changes. Existing `WorkflowRun` + `Phase` rows hydrate unchanged. The new `"open_pr"` kind is an enum extension only.
- **No SDK dependency.** Implementation shells out to the system `gh` (per ED-6). No `@octokit/*` or similar npm dependency added.
- **Strict TS + lint matching the rest of the repo.** Same coverage thresholds as `mcp-server` from V1 phase 8 (80% statements / 75% branches). Comment style follows the repo's `//`-only rule.
- **Workspace-agnostic posture preserved.** `openPr` takes a `workflowRunId`; the workdir is derived from the run's recorded fields. No Tower dependency. The `GhClient` interface keeps the gh shell-out behind an abstraction, so a future "open PR via GitHub REST" backend can drop in without touching the service.
- **Tests at every layer.** Unit tests for `openPr` against a `FakeGhClient`; MCP handler smoke test that asserts the new return shape; one new L3 subprocess integration test under `e2e/integration/` that runs the tool against a sandboxed git repo + a `gh`-shaped stub binary.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Where the `open_pr` capability sits | New `OpenPrService` next to `ShipService` in `@ship/core` | Extend `ShipService` with an `openPr` method | Interface segregation. `ShipService.ship` is about running an agent; opening a PR is a separate verb with separate failure modes. Bundling them would inflate the surface every consumer has to type-check against. |
| `gh` CLI vs GitHub SDK | Shell out to `gh` via a `GhClient` interface | Take `@octokit/rest` as a direct dep | `gh` is already the operator workflow's PR tool (CLAUDE.md § Shipping Features); it owns auth state, retries, and error mapping. An SDK would re-implement those and add an OAuth-token-management story Ship doesn't otherwise need. The interface boundary still lets a future backend swap in. |
| Sync vs async MCP contract | Sync — return the full result | Mirror phase 01's `{ workflowRunId, status: "running" }` async shape | Latency is sub-second; the async pattern's complexity is unjustified. See F4. |
| Title/body sourcing | Derive from task doc front-matter + commits, with caller overrides | Require caller to supply title/body | DX. The agent calling `open_pr` already has the doc and the commits in context; making the tool extract them by default keeps the happy path one-line. Overrides cover the cases where the agent wants a custom narrative. |
| Idempotency on existing-open PR | Return the existing PR with `alreadyExisted: true` | Fail with `PrAlreadyExistsError` | Retry-safety for agent callers that lost the prior result (e.g. session reset mid-flight). Failing would push correctness onto every caller; idempotency is cheap (one extra `gh pr list` call). |
| Cancellation | Best-effort — observe `controller.signal`, but the window is sub-second | Make `open_pr` formally non-cancellable | The signal-observation cost is one `if (signal.aborted) throw` between the push and the create. Practically untestable, but documenting the intent ("we observe cancel, but don't promise to hit a particular point") keeps the cancel contract uniform with V1. |
| CLI mirror | Yes — `ship open_pr <workflowRunId>` | MCP-only | Human dogfood. Operators driving `ship` from the CLI today land on the same "I need a PR for this branch" step; the CLI mirror saves a `gh pr create` invocation. Per spec.md § ED-2, the CLI mirror is "opportunistic" — open_pr is one of the cases where it pays off. |
| Base branch resolution | Mirror `gh pr create`'s own resolution order: `input.base` → `branch.<current>.gh-merge-base` (git config) → `origin/HEAD` | Hard-code `main`, or skip the `gh-merge-base` step | `gh pr create` checks the `branch.<name>.gh-merge-base` config before falling back to the repo's default branch (used for release-branch workflows where `main` is the wrong target). Skipping that step would silently retarget PRs in repos that intentionally configured a non-default merge base. Matching gh's full resolution order is the principle-of-least-surprise contract for operators who already use `gh` directly. Caller can override via `base` input. |

## Engineering decisions

### ED-1 — `OpenPrService` is a new interface in `@ship/core`

`packages/core/src/open-pr.ts` (new file) exports an `OpenPrService` interface and a `createOpenPrService(config: OpenPrServiceConfig): OpenPrService` factory. The interface has one method:

```ts
export interface OpenPrService {
  openPr(input: OpenPrInput): Promise<OpenPrOutput>;
}
```

`OpenPrServiceConfig` carries the same store + clock + logger surface `ShipServiceConfig` does, plus the two new backend interfaces (see ED-6):

```ts
export interface OpenPrServiceConfig extends BaseServiceConfig {
  readonly gh: GhClient;
  readonly git: GitRemote;
  // V1 ED-2 active-runs registry — shared with ShipService so
  // cancel_workflow_run can signal an in-flight open_pr phase. See ED-8.
  readonly activeRuns: ActiveRunsRegistry;
}
```

`GhClient` and `GitRemote` are structural interfaces so unit tests substitute thin fakes per ED-6. The `mcp-server` package's default wiring constructs both `ShipService` and `OpenPrService` from the same store + clock + active-runs map, with `gh: createNodeGhClient()` + `git: createNodeGitRemote()` plugged in.

Two services rather than one is the point: `mcp-server` imports `OpenPrService` only for the `open_pr` tool handler; `cli` imports both. Code that only consumes `ShipService` doesn't pay typecheck cost for the open_pr surface.

### ED-2 — State machine: pre-row validation, then phase row, then shell out

The synchronous step ordering inside `OpenPrService.openPr(input)`:

1. **Pre-row validation** (no DB write yet) in F3's documented order:
   - `parse(input)` against `openPrInputSchema`.
   - Look up `WorkflowRun` (throws `WorkflowRunNotFoundError` on miss).
   - Confirm implement phase is `succeeded` (throws `ImplementPhaseNotSucceededError`).
   - Confirm workdir is a git checkout (throws `WorkdirNotGitError`).
   - **Resolve the base branch**: `input.base` ?? `git.readConfig({ workdir, key: "branch.<head>.gh-merge-base" })` ?? `git.readDefaultBranch({ workdir })`. If all three return null/throw, throw a typed `BaseBranchUnresolvedError`. See ED-6 for the new `GitRemote` read methods (split out from `GhClient` to keep git-side and gh-side ops on separate interfaces).
   - **Idempotency probe**: `gh.listOpenPrsForBranch({ workdir, head, base })`. If a PR exists, **skip ahead** to step 5 with `alreadyExisted: true` (no push, no create — but we still write a `Phase` row in `succeeded` state, see step 5).
   - If no existing PR, confirm the branch has commits ahead of base (throws `EmptyBranchError`). This check runs *after* idempotency so a retry against a cherry-picked-into-base branch still resolves via the existing PR.
2. **Persist row**: write `Phase{kind: "open_pr", status: "pending", workflowRunId, createdAt}`. Throws ⇒ same as above (no row), state is consistent because step 1 already returned the data we need.
3. **Transition**: `phase.status: pending → running` via the existing `@ship/workflow` transition helper.
4. **Mutate** (skipped on the idempotent path):
   - **Push** (`git.pushBranch({ workdir, branch })` — ED-6): wraps the push in a try/catch that maps `BranchPushFailedError` for known failure modes (force-needed, branch-protected).
   - **Open PR**: `gh.createPr({ workdir, base, head, title, body, draft })`. Returns `{ number, url }`. Errors map to `GhCreatePrFailedError` with the captured stderr.
5. **Write `result.json` artifact** with the result shape (including `alreadyExisted`); transition `phase.status → succeeded`; return the output.

Errors during step 4 transition `phase.status → failed` and persist the error in `result.json` (mirroring V1's `finalizeFailure` pattern). The MCP handler maps the typed error to `isError: true` with a structured message.

### ED-3 — Zod schemas live in `@ship/mcp`; `OpenPrInput` / `OpenPrOutput` types live in `@ship/core`

This is the one layering subtlety on the new surface. Phase 01 left it implicit; this phase pins it down so the impl PR can't accidentally introduce a `core → mcp` import.

- **Types** (plain TS, no Zod) — defined in `@ship/core` next to `OpenPrService`:

  ```ts
  // packages/core/src/open-pr.ts
  export interface OpenPrInput { workflowRunId: WorkflowRunId; base?: string; title?: string; body?: string; draft?: boolean }
  export interface OpenPrOutput { workflowRunId: WorkflowRunId; phaseId: PhaseId; prNumber: number; prUrl: string; base: string; head: string; alreadyExisted: boolean; status: "succeeded" }
  ```

- **Zod schemas** — defined in `@ship/mcp`, `z.infer<>` is asserted equal to the core types via a structural typecheck:

  ```ts
  // packages/mcp/src/open-pr.ts
  import type { OpenPrInput, OpenPrOutput } from "@ship/core";

  export const openPrInputSchema = z.object({
    workflowRunId: workflowRunIdSchema,
    base: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    draft: z.boolean().optional().default(false),
  }).strict();

  export const openPrOutputSchema = z.object({
    workflowRunId: workflowRunIdSchema,
    phaseId: phaseIdSchema,
    prNumber: z.number().int().positive(),
    prUrl: z.string().url(),
    base: z.string().min(1),
    head: z.string().min(1),
    alreadyExisted: z.boolean(),
    status: z.literal("succeeded"),
  }).strict();

  // Compile-time assertion: the schema's inferred shape must match the
  // core type. If they drift, this line fails to typecheck.
  type _InputMatches = z.infer<typeof openPrInputSchema> extends OpenPrInput
    ? OpenPrInput extends z.infer<typeof openPrInputSchema>
      ? true
      : false
    : false;
  ```

The dependency arrow stays `mcp → core` (one direction). The MCP layer owns runtime validation; the core layer owns the shape contract. The compile-time `_InputMatches` (and a sibling for output) catches drift without runtime cost.

A V1 follow-up should retro this rule onto `ShipStartOutput` (phase 01 ED-3 leaves the equivalent question implicit — current code happens to work because phase 01's types were never imported back into `@ship/core`, but the convention should be codified). Tracked as an out-of-scope follow-up, not gating this phase.

Both schemas are `.strict()` so the wire payload can't leak unknown fields — same posture as phase 01's `shipStartOutputSchema`. The `status` narrowing to `z.literal("succeeded")` mirrors phase 01 ED-3: a future implementation that accidentally returns a different status fails Zod validation at the boundary, not silently downstream.

### ED-4 — Idempotency uses `gh pr list`, not a local SQL check

Detection of an existing-open PR queries `gh pr list --head <branch> --base <base> --state open` rather than reading the `phases` table. Reasons:

- The Ship store may not have a row for an externally-opened PR (an operator can `gh pr create` outside Ship). Asking GitHub directly is the source of truth.
- A `Phase` row for a *previous* `open_pr` call is no guarantee the PR is still open — it could have been merged or closed in the meantime.
- The cost is one extra `gh` invocation (typically < 300ms). Cheap.

The `alreadyExisted` flag on the output distinguishes the two paths so the caller can react if it cares (e.g. an agent that wants to add a comment when reopening vs creating).

### ED-5 — Title/body derivation: front-matter, then commits

When `title` is omitted, the impl derives it as follows:

1. Read the run's recorded `docPath` (relative to `workdir`). Open it.
2. The first markdown H1 (`# ...`) is the candidate title. If the H1 already has a conventional-commit prefix (`feat:`, `fix:`, `chore:`, etc.), use it verbatim. Otherwise infer the prefix from the branch name's first path segment (`fix/...` → `fix:`, `chore/...` → `chore:`, `docs/...` → `docs:`, `refactor/...` → `refactor:`, `test/...` → `test:`); fall back to `feat:` only when no segment matches a known CC prefix.
3. If the doc has no H1 (rare, but possible for ad-hoc tasks), fall back to the branch name with `-` → space, applying the same CC-prefix inference above (e.g. `fix/empty-branch` → `fix: empty branch`).

Branch-prefix inference is the lighter touch Claude's cycle-1 review flagged — hard-coding `feat:` for every non-CC H1 would misrepresent bug-fix branches as features in commit history. Caller override via `input.title` bypasses both derivations entirely.

When `body` is omitted, the impl derives it from `git log --format='- %s' <base>..<head>` — one bullet per commit. The result is the standard "Summary / Changes" template with the commit list under "Changes." This matches the human-authored PR style used elsewhere in the repo.

Both derivations happen inside `OpenPrService` (testable unit), not the MCP layer. The CLI mirror gets the same derivation for free.

A future phase could compose richer body content (e.g. diff stats, linked issues). Not in V1.

### ED-6 — Split `GitRemote` + `GhClient` interfaces, with `NodeGitRemote` and `NodeGhClient` default impls

The shell-out surface naturally splits along the git/gh seam. Bundling them on one interface conflates two distinct backends — `pushBranch` and `readGitConfig` are local-git operations a future Octokit-based PR backend wouldn't touch, while `listPrsForBranch` and `createPr` are GitHub-API operations a local-git backend wouldn't touch. Splitting also gives unit tests two narrower fakes; the push-failure path can be exercised without wiring a full PR-mock.

`packages/core/src/git-remote.ts` (new file):

```ts
export interface GitRemote {
  // Reads the local `branch.<branch>.gh-merge-base` git config value.
  // Returns `null` if unset. Used by base-branch resolution per ED-2.
  readConfig(opts: { workdir: string; key: string }): Promise<string | null>;
  // Returns the branch pointed at by `origin/HEAD`. On most CI checkouts
  // `origin/HEAD` is set; on shallow clones via `actions/checkout`
  // without `fetch-depth: 0` it isn't. Impl falls back to
  // `git remote show origin` (one network round-trip) on the unset path
  // and surfaces a typed `OriginHeadUnsetError` if both fail. See
  // Risks → "origin/HEAD unset on CI checkouts."
  readDefaultBranch(opts: { workdir: string }): Promise<string>;
  pushBranch(opts: { workdir: string; branch: string }): Promise<void>;
}
```

`packages/core/src/gh.ts` (new file):

```ts
export interface GhClient {
  listOpenPrsForBranch(opts: { workdir: string; head: string; base: string }): Promise<GhPrRef[]>;
  createPr(opts: { workdir: string; base: string; head: string; title: string; body: string; draft: boolean }): Promise<GhPrRef>;
}

export interface GhPrRef {
  readonly number: number;
  readonly url: string;
}
```

`listOpenPrsForBranch` bakes the `--state open` filter into the method name (so the filter is visible at every call site), since the only use of this method in V1 is the idempotency check from F5. If a future caller needs other states, add a separate verb rather than parameterizing — keeps each verb's intent unambiguous.

Default impls `createNodeGitRemote(): GitRemote` and `createNodeGhClient(): GhClient` live next to their interfaces; both shell out via `execa`. Stderr is captured and threaded into the typed errors above.

Op-by-op grounding in shell-out terms:

- `GitRemote.readConfig` — `git -C <workdir> config --get <key>` (exit 0 → value; exit 1 + no stderr → null per git convention).
- `GitRemote.readDefaultBranch` — `git -C <workdir> symbolic-ref --short refs/remotes/origin/HEAD` first; on miss, `git -C <workdir> remote show origin` and parse the `HEAD branch:` line; on miss, throw `OriginHeadUnsetError`.
- `GitRemote.pushBranch` — `git -C <workdir> push -u origin <branch>`.
- `GhClient.listOpenPrsForBranch` — `gh pr list --head <head> --base <base> --state open --json number,url` parsed into the narrow `GhPrRef[]`.
- `GhClient.createPr` — `gh pr create --base <base> --head <head> --title <title> --body <body> [--draft]` parsed for the resulting PR url + number.

Two notes on the interface shape:

- Every method takes an explicit `workdir`. Implementations that span multiple worktrees in one process (e.g. a future cloud runtime) need to scope each call; not having a `workdir` field would force shared cwd state.
- `GhPrRef` narrows the raw `gh` JSON (dozens of fields) to the two we use. Typescript catches drift on the boundary.

`OpenPrServiceConfig` carries both:

```ts
export interface OpenPrServiceConfig extends BaseServiceConfig {
  readonly gh: GhClient;
  readonly git: GitRemote;
}
```

Substitution example for unit tests:

```ts
const git: GitRemote = {
  readConfig: vi.fn().mockResolvedValue(null),
  readDefaultBranch: vi.fn().mockResolvedValue("main"),
  pushBranch: vi.fn().mockResolvedValue(undefined),
};
const gh: GhClient = {
  listOpenPrsForBranch: vi.fn().mockResolvedValue([]),
  createPr: vi.fn().mockResolvedValue({ number: 42, url: "https://github.com/.../pull/42" }),
};
```

Future work explicitly **not** in this phase: an `OctokitGhClient` for environments where `gh` isn't installed. Swapping `GhClient` doesn't touch the `GitRemote` surface — the seam stays clean.

### ED-7 — CLI mirror: `ship open_pr <workflowRunId>`

`packages/cli/src/commands/open-pr.ts` (new file) wires Commander to `OpenPrService.openPr`. Flags mirror the MCP input (`--base`, `--title`, `--body`, `--draft`), plus `--json` for machine-readable output (consistent with V1 `ship list --json`).

Error mapping reuses the existing CLI exit-code conventions: typed user errors (missing run, empty branch, gh missing) exit 1; unexpected throws exit 2. The mapping table lives in `packages/cli/src/errors.ts` next to V1's; one new entry per new typed error.

### ED-8 — Cancellation: shared `activeRuns` registry, best-effort signal observation

V1 phase 8 / phase 01 own the `activeRuns: ActiveRunsRegistry` — a `Map<workflowRunId, { controller: AbortController }>` populated by `ShipService` when a run starts and consumed by `cancel_workflow_run` to abort the in-flight cursor invocation. V2 phase 02 reuses the same registry rather than introducing a parallel one.

How an `open_pr` run gets a controller into `activeRuns`:

1. `OpenPrServiceConfig` (ED-1) holds a reference to the shared `activeRuns`.
2. On `openPr` entry, before step 1's precondition pass, the service constructs a new `AbortController` and calls `activeRuns.set(workflowRunId, { controller })`. If an entry already exists (e.g. left over from a still-active `ship` run on the same workflowRunId — practically impossible at this point because precondition step 2 already verified implement is terminal, but defensively), the call rejects with a `WorkflowRunStillActiveError`. Otherwise we now have a registered controller.
3. `openPr` observes `controller.signal.aborted` at two checkpoints: after precondition resolution (before the `git.pushBranch` call) and after the push (before `gh.createPr`). If aborted, the service transitions the phase to `cancelled`, writes `result.json` with the abort reason, and throws an `AbortError`.
4. On normal completion (succeeded path) and failure paths, the service `activeRuns.delete(workflowRunId)` before returning, mirroring V1's `finalizeFailure` cleanup.

`cancel_workflow_run` itself doesn't change. It already finds the controller in `activeRuns` and calls `controller.abort()`. Whether the in-flight phase is `implement` or `open_pr` is opaque to the cancel verb — it signals the registry and the active service consumes the signal.

The observable window is sub-second so most cancels race the completion. Documenting the wiring is the load-bearing part here; the cancel behavior is uniform with V1, and the test fakes register on the same shared `ActiveRunsRegistry` from `@ship/test-harness` to keep the assertion surface identical.

## Validation plan

### Unit tests (Vitest)

- `core`: `openPr` happy-path returns `{ ..., status: "succeeded", alreadyExisted: false }`; writes `Phase{kind: "open_pr", status: "succeeded"}` + `result.json`; calls `git.pushBranch` + `gh.createPr` exactly once.
- `core`: `openPr` idempotent path — when `gh.listOpenPrsForBranch` returns an existing PR, no push, no create, output has `alreadyExisted: true`, phase row written in `succeeded` directly.
- `core`: **idempotency-before-empty-branch ordering** — branch has zero commits ahead of base AND an existing open PR. Resolves to the existing PR (no `EmptyBranchError`). Mirrors a real cherry-pick scenario; ordering bug would silently regress F5.
- `core`: preconditions — run-not-found, implement-phase-not-succeeded, workdir-not-git, empty-branch-without-existing-PR, base-branch-unresolved. Each throws the typed error, **no phase row created**.
- `core`: **base-branch resolution order** — `input.base` wins over both `GitRemote` reads; absent that, `branch.<head>.gh-merge-base` from `git.readConfig` wins over `git.readDefaultBranch`; absent all three, throw `BaseBranchUnresolvedError`. Three scenarios, one per fallback level.
- `core`: **`OriginHeadUnsetError` is recoverable via `readDefaultBranch` fallback** — `symbolic-ref` returns null, `remote show origin` returns "main"; service consumes the fallback and proceeds (covers the CI / shallow-clone path called out in Risks).
- `core`: **cancellation registers + clears `activeRuns`** — abort signalled mid-precondition vs. mid-push transitions the phase to `cancelled` and removes the workflowRunId from `activeRuns`. Two scenarios, one per checkpoint.
- `core`: failure paths — push fails, create fails. Phase row transitions `running → failed`; `result.json` contains the error message.
- `core`: title/body derivation — H1 with conventional-commit prefix; H1 without prefix but branch starts with `fix/` (inferred `fix:`); H1 without prefix on an unknown branch prefix (fallback `feat:`); no H1 (branch-name fallback with CC inference); explicit `input.title` override bypasses derivation entirely.
- `mcp`: schema `_InputMatches` / `_OutputMatches` compile-time assertions confirm `z.infer<typeof schema>` equals the core type. A drift between schema and type breaks the typecheck step of `make check`.
- `mcp`: `openPrInputSchema` parses valid + rejects invalid; `openPrOutputSchema` likewise. Strict-mode rejection of extraneous fields.
- `mcp-server`: `open_pr` tool handler returns the success shape on a fake service; returns `isError: true` on a service rejection. Uses `InMemoryTransport` per V1 phase 8.
- `cli`: `ship open_pr <id>` parses, calls service, prints expected text + `--json` shape; exit codes match the typed-error mapping table.

### Integration tests

One new test under `e2e/integration/open-pr.integration.test.ts` (subprocess MCP server + real on-disk SQLite + a `gh`-shaped stub binary that records its invocations and returns canned JSON). Covers:

1. `ship` against a fixture task doc → `open_pr` against the resulting `workflowRunId` → assert the stub was called with the right args + the returned `prUrl` matches the canned response.
2. Second `open_pr` against the same run → assert `alreadyExisted: true` (stub returns the existing PR on `list`).

The stub binary lives under `e2e/fixtures/gh-stub/` and is selected via `SHIP_GH_BINARY=...` env (parallel to V1's `SHIP_TEST_FAKE_CURSOR`). The stub is < 50 LOC of Node.

### L3 (live e2e, opt-in via `SHIP_LIVE=1`)

Optional. The existing `e2e/scenarios/` live harness gets one new scenario that opens a real PR on a sandbox repo (e.g. `itsHabib/agent-sandbox`). Gated behind `SHIP_LIVE=1` so CI doesn't burn quota. Asserts the PR is open with the expected title/body.

### Acceptance for the phase

- Both PRs (this doc, then the impl) merged on `main`.
- `make check` + integration suite green on ubuntu + windows CI.
- A manual `mcp__ship__open_pr { workflowRunId }` invocation from a real MCP client opens a PR and returns its URL within < 5s.
- Dogfood: one V2 task chain — `ship` → `open_pr` — runs end-to-end without falling out of any tool-call timeout, and the resulting PR url is auto-recorded as a `Phase{kind: "open_pr"}` artifact on the run.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `gh` CLI missing on the host | Tool returns a confusing "command not found" error to the agent | Preflight check in `createNodeGhClient` — on first call, runs `gh --version`; if it fails, throws a typed `GhCliMissingError` with install instructions in the message. Surfaced through the MCP error shape. |
| `gh` auth expired / missing | Push or create returns an auth error mid-flight | Same preflight + `gh auth status` check on first call. Typed `GhAuthError` with the next-step instruction. Cheaper to surface as preflight than to map every `gh` stderr variant downstream. |
| Branch protection rejects the push (e.g. main-only rules misapplied) | Phase transitions to `failed` with a push-rejected error; user has no clear path forward | The typed `BranchPushFailedError` preserves the `git push` stderr in `result.json`. Docs note the most common cases (protected default branch, missing required status checks on the target). |
| Repo has a `.github/pull_request_template.md` | `gh pr create` may overlay our body with the template, producing weird mixed output | `gh pr create --body` overrides the template entirely (verified via `gh` source). Document this in the impl PR's changelog so operators with custom templates aren't surprised. If a future phase wants to *merge* template + derived body, that's an explicit follow-up. |
| Idempotent re-open hits a *closed* PR | We open a second PR; operator now has two PRs referencing the same branch | Working as designed — see F5. The `alreadyExisted` flag in the output covers only the open case; merged/closed PRs are historically valid. Surface the second PR's url as the new authoritative one. |
| Cancel during open_pr | Sub-second window; cancel may arrive after the push but before the create | ED-8: best-effort observation; document the window as part of the cancel semantics. The state machine transitions to `cancelled` if the signal fires before the `gh.createPr` call returns; otherwise the run completes and the cancel is reported as "race condition, run already completed" through the existing `cancel_workflow_run` response shape. |
| `result.json` artifact size unbounded if the gh stderr is verbose | Disk fills on a hostile or malformed gh output | Cap the captured stderr at 8 KB in `result.json` (matching the V1 cursor-run capture cap). Excess goes into the run's `events.ndjson` for debugging. |
| Future SDK swap forces interface revisions | Hard to drop in `OctokitGhClient` later | `GhClient` is shaped around the two GitHub-API ops Ship performs (list-open / create); `GitRemote` owns the local-git ops (read-config / read-default-branch / push). An Octokit impl swaps `GhClient` only and leaves `GitRemote` alone, which is what the split in ED-6 buys. |
| `origin/HEAD` unset on CI checkouts | `actions/checkout` without `fetch-depth: 0` and shallow clones don't initialize `refs/remotes/origin/HEAD`. A direct `symbolic-ref --short refs/remotes/origin/HEAD` returns null and the impl would throw `BaseBranchUnresolvedError` even though `main`/`master` is reachable on the remote. | `GitRemote.readDefaultBranch` (ED-6) falls back to `git remote show origin` and parses the `HEAD branch:` line on the unset path — one network round-trip, ~200ms, runs once per service lifetime. Only throws `OriginHeadUnsetError` after both probes return null. CI authors can also pre-warm with `git remote set-head origin -a` in a setup step if they want the symref path. |
| Two `open_pr` calls in parallel on the same branch | Race could create two PRs | Lock-acquisition pattern: the `phases` row is written in `pending` *before* the gh list/create, and the V1 transitional helper rejects a second `pending` open_pr phase on the same run. A second concurrent call lands in `running` after the first transitions, by which point the idempotency check sees the just-created PR. Test coverage explicitly forces this race. |

## Out of scope

- **Updating an already-open PR's title / body / labels.** A separate `update_pr` tool (or relaxing `open_pr`'s contract to "open-or-update") is a different design conversation; this phase only opens. If an agent needs to edit a PR's metadata after open, it falls back to `gh pr edit` directly until a future phase formalizes the operation.
- **Closing / merging PRs.** Different verb, different state machine. Phase 04+ territory.
- **Multi-repo PR opening (e.g. companion PRs in dependent repos).** V1 spec.md § Non-goals already excludes cross-repo coordination; reaffirmed here.
- **Drafting PRs from a partial implementation phase.** The precondition explicitly requires implement-phase `succeeded`. A future "open as draft from running implementation" is a separate phase if the dogfood need shows up.
- **Cloud Cursor runtime.** Same as phase 01 — deferred. Neither `GhClient` nor `GitRemote` cares which runtime ran the implement phase; both operate on the recorded workdir + branch.
- **Streaming progress notifications.** Same answer as phase 01 — deferred until the MCP client surface supports it uniformly.
- **Adding the `alreadyExisted: true` PR's author back to the run as the human-of-record.** Audit trail concerns. Punt to a future phase if needed.

## Open questions

1. **Should `open_pr` automatically request reviewers per repo convention?** Default: no — the operator workflow (CLAUDE.md § Shipping Features) handles reviewer requests as a separate explicit step. Auto-requesting would couple this phase to the reviewer convention, which evolves. If a future phase 03 (review-cycle) wants this, it can call `gh pr edit --add-reviewer` after `open_pr` returns.
2. **Should the input accept an optional `reviewers` list?** Tempting, but it's the same coupling as (1) wearing a different hat. Defer. If demand surfaces in dogfood, add it as a backward-compatible optional field — strict mode admits an additive field through a schema revision.
3. **What about `assignees` / `labels` / `milestone`?** Same answer — optional fields are cheap to add later. None in V1.
4. **Should the impl support repos hosted outside GitHub (e.g. GitLab)?** Out of scope for V1 — `GhClient` is GitHub-specific by name (and `GitRemote`, while git-flavored, currently assumes GitHub-style `origin` semantics). A future `ForgeClient` abstraction could lift this; defer until the second forge actually shows up.
5. **Should `open_pr` write a top-level `WorkflowRun.prUrl` field for convenience?** Default: no — the `Phase` row's `result.json` carries it. Surfacing it on the top-level row duplicates state and risks drift. Callers read it from the phase. Revisit if the duplication friction becomes real.

## Implementation plan

After this doc is reviewed and merged:

1. **Extend `Phase.kind` enum in `@ship/workflow`.** Add `"open_pr"` to the zod schema. Add a `PhaseOpenPrResult` shape for `result.json` (number, url, base, head, alreadyExisted, error?). Update the type re-exports.
2. **Add the `OpenPrInput` / `OpenPrOutput` interfaces to `@ship/core`** (per ED-3). Plain TS, no Zod yet.
3. **Add `openPrInputSchema` + `openPrOutputSchema` to `@ship/mcp`** with the structural assertions against the core types per ED-3. Strict mode on both.
4. **Add `GitRemote` interface + `createNodeGitRemote` impl in `@ship/core`** — new file `packages/core/src/git-remote.ts`. Three methods (`readConfig`, `readDefaultBranch`, `pushBranch`); `readDefaultBranch` includes the `git remote show origin` fallback for CI checkouts per Risks. Typed errors: `OriginHeadUnsetError`, `BranchPushFailedError`.
5. **Add `GhClient` interface + `createNodeGhClient` impl in `@ship/core`** — new file `packages/core/src/gh.ts`. Two methods (`listOpenPrsForBranch`, `createPr`). Preflight check (gh installed + authed) lazily on first call. Typed errors: `GhCliMissingError`, `GhAuthError`, `GhCreatePrFailedError`.
6. **Add typed pre-condition errors in `@ship/core`.** `ImplementPhaseNotSucceededError`, `WorkdirNotGitError`, `EmptyBranchError`, `BaseBranchUnresolvedError`. Reuse `WorkflowRunNotFoundError` from V1.
7. **Add `OpenPrService` interface + `createOpenPrService` impl in `@ship/core`** — new file `packages/core/src/open-pr.ts`. State-machine ordering per ED-2 (including the idempotency-before-empty-branch sequence and the shared `activeRuns` registry per ED-8). Title/body derivation per ED-5 (helper functions, unit-tested with branch-prefix CC inference).
8. **Wire the MCP tool handler in `@ship/mcp-server`.** New file `packages/mcp-server/src/tools/open-pr.ts`. Mirror the V1 tool-handler pattern from `ship.ts`. Register in `buildServer()`.
9. **Add the CLI subcommand in `@ship/cli`.** New file `packages/cli/src/commands/open-pr.ts`. Add the typed-error mapping rows to `packages/cli/src/errors.ts`.
10. **Tests.** Unit tests for `openPr`, the two shell-out boundaries (with a fake `execa`), the schema (incl. the compile-time `_InputMatches` / `_OutputMatches` assertions), the MCP handler, and the CLI command. One new integration test under `e2e/integration/` using the gh-stub binary (per Validation).
11. **Wire default service construction.** Extend `packages/core/src/default-wiring.ts` to construct `OpenPrService` alongside `ShipService` (sharing the `activeRuns` registry) so `mcp-server` and `cli` both pick it up via the existing factory pattern.
12. **Land as one PR.** Estimated weighted budget ~320 LOC (small bump from the original ~285 to absorb `GitRemote` + the `activeRuns` plumbing) — single PR per the V1 sizing rule. If the diff comes in over 500 weighted LOC, the natural split is "core + workflow schema + GitRemote" / "GhClient + OpenPrService + MCP/CLI/tests."

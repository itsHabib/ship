# Phase 04 — cursor cloud runner

Status: design draft, revision 2 (2026-05-18). Cycle-2 review addressed; awaiting cycle-3 sign-off.
Owner: itsHabib
Date: 2026-05-18

> **Companion docs.** [spec.md](../spec.md) § Non-goals explicitly deferred cloud runtime ("V2 doesn't [ship a cloud runtime] ... admits a cloud impl whenever someone files a phase doc for it") — this is that doc. [docs/cursor-sdk-leverage.md](../../../cursor-sdk-leverage.md) § Tier 3 #7 ("Cloud runtime") is the source-of-record for what cloud unlocks. [docs/cursor-sdk-typescript.md](../../../cursor-sdk-typescript.md) § Local vs cloud runtime + § `Agent.create()` is the SDK reference. [phases/02-open-pr.md](02-open-pr.md) is the predecessor that this phase composes with (cloud `autoCreatePR` interacts with the `open_pr` phase — see F4). [V1 phase 05](../../ship-v1/phases/05-cursor-runner.md) is the `CursorRunner` interface progenitor; the interface was designed cloud-aware from day one (per [runner.ts:71](../../../../packages/cursor-runner/src/runner.ts) "Empty for local runs; populated by cloud (V2)").

## Scope

**Weighted-LOC budget — doc-only this PR. 0×.** Amazing trivially.

The phase produces two changes in this PR:

- `docs/features/ship-v2/phases/04-cursor-cloud-runner.md` (this file).
- `docs/features/ship-v2/spec.md` amendment: lift cloud from Non-goals, renumber CI-repair from phase 04 to phase 05, update the relevant Risks row.

Follow-up implementation PRs are sized in § Implementation plan. Each implementation step targets the "amazing" band (<500 weighted LOC) per [CLAUDE.md § PR sizing](../../../../CLAUDE.md#pr-sizing); the largest projected step is the `CloudCursorRunner` skeleton at ~280 weighted LOC.

## Summary

V1 ships exactly one `CursorRunner` impl — `LocalCursorRunner`. The SDK's `Agent.create({ cloud: {...} })` path is unused. Cloud agents run in Cursor-hosted VMs with full http access and a desktop environment; they survive Ship-process restart, can open PRs themselves via `cloud.autoCreatePR`, and unlock parallel runs that don't block on local hardware.

This phase introduces `CloudCursorRunner` as a second impl of the existing `CursorRunner` interface and wires runtime selection through the `ship.ship` MCP tool. Default behavior stays local — every existing caller keeps working unchanged. Callers that pass `runtime: "cloud"` (with the required cloud-config fields) get a cloud-hosted run.

Three substrate-shaped follow-ons this phase deliberately *defers* to their own phases or follow-up tasks:

- **Agent resume across phases** ([cursor-sdk-leverage.md § Tier 3 #6](../../../cursor-sdk-leverage.md)) — cloud agents survive process restart, so `Agent.resume` becomes meaningful. The current `CursorRunHandle` shape doesn't model resume; redesigning that is its own phase.
- **Artifact pickup** (`agent.listArtifacts` / `downloadArtifact`) — cloud-only feature with no existing Ship surface. Defer to a follow-up "cloud artifacts" phase if dogfood proves the need.
- **`autoCreatePR` as the default cloud path** — cloud *can* open PRs itself. Phase 02's `open_pr` already exists and handles the local path; rather than fork the flow, cloud runs default to `autoCreatePR: false` and call `open_pr` like local runs. Opt-in to `autoCreatePR: true` is supported (see F4) but the canonical path stays uniform.

What this phase explicitly **does not** do:

- It does not deprecate `LocalCursorRunner`. Both runners coexist; the caller picks per run.
- It does not change the `CursorRunner` interface shape. Existing methods, existing return types. Only the input grows two optional discriminator fields (see F2 / ED-2).
- It does not introduce a provider-agnostic substrate (Claude SDK, etc.). That's V3 candidate territory tracked separately as `tsk_01KRVAJVYJDT9Z7Q6A7H53RYWC`. Cloud cursor stays inside `@ship/cursor-runner`.
- It does not change the SQL schema. Cloud runs persist into the same `cursor_runs` table; `branches` was always part of the run record (V1).

## Functional requirements

### F1 — `CloudCursorRunner` is a second `CursorRunner` impl

A new file `packages/cursor-runner/src/cloud-runner.ts` implements the `CursorRunner` interface. Surface mirrors `LocalCursorRunner` (`run(input)` returns a `CursorRunHandle` with `agentId`, `runId`, `result`, `cancel`). The internal `#startAgent` / `#runPipeline` shapes mirror local-runner.ts wherever possible — same stream/wait/cancel pipeline, same `mapRunResult` mapping, same `Symbol.asyncDispose` cleanup.

The class diverges from `LocalCursorRunner` in exactly four places:

1. **`Agent.create` config.** Passes `cloud: { ... }` instead of `local: { cwd, settingSources }`. Cloud config fields (repos, env, autoCreatePR, etc.) come from `CursorRunInput.cloud` per F2.
2. **`settingSources` is not set.** The SDK doc explicitly says `local.settingSources` does not apply to cloud agents. Project-loaded subagents come from `.cursor/agents/*.md` committed to the repo, not from `local.settingSources` plumbing (see F5).
3. **Cancellation is async-tolerant.** Cloud `run.cancel()` round-trips to the VM; latency is higher than local. The existing cancel pipeline (idempotent via `terminated` + `cancelInitiated` guards) already tolerates this. No new code shape, just documented in the new runner's class comment.
4. **`EXPIRED` status is mapped.** Cloud emits `status: "EXPIRED"` when the agent's time budget runs out (cloud-only; local never expires). Ship maps this to its `cancelled` terminal vocabulary — the run didn't finish, didn't error, was terminated by the platform. Alternative mapping to `failed` is rejected per ED-5.

The class exports under `@ship/cursor-runner`'s existing index:

```ts
// packages/cursor-runner/src/index.ts
export { CloudCursorRunner } from "./cloud-runner.js";
```

### F2 — `CursorRunInput` grows two optional discriminator fields

The interface accommodates cloud-specific config additively:

```ts
// packages/cursor-runner/src/runner.ts
export interface CursorRunInput {
  // ...existing fields...

  /** Runtime selector. Defaults to "local" when omitted. */
  readonly runtime?: "local" | "cloud";

  /**
   * Cloud-specific config. Required when runtime === "cloud"; ignored
   * otherwise. Validated at the runner boundary, not in the type system,
   * to keep the discriminated-union complexity off existing callers.
   */
  readonly cloud?: CloudRunSpec;
}

export interface CloudRunSpec {
  /**
   * GitHub repo the cloud agent operates against. Exactly one entry this
   * phase — multi-repo runs are out of scope (see § Out of scope and OQ #3).
   * The schema enforces `.length(1)`.
   */
  readonly repos: readonly [{ readonly url: string; readonly startingRef?: string; readonly prUrl?: string }];
  /**
   * Push to existing branch instead of creating a new one. Default: false.
   * **Experimental** — the field passes through to the SDK but the
   * workflowRun-as-one-new-branch shape isn't designed for it. See § Out of scope.
   */
  readonly workOnCurrentBranch?: boolean;
  /**
   * Auto-open a PR when the cloud run finishes. **Default: true** for cloud
   * (the cloud VM opens the PR via the SDK's `autoCreatePR` flow). Local
   * runs ignore this field and continue to use the explicit `open_pr` phase.
   * See F4 for the rationale; the symmetric "cloud + explicit `open_pr`"
   * shape is a follow-up phase (open_pr currently reads local git state and
   * has no path to a cloud-produced branch).
   */
  readonly autoCreatePR?: boolean;
  /**
   * Skip requesting the calling user as PR reviewer. Defaults to `true` when
   * `autoCreatePR === true` (Ship's caller already knows about the PR — they
   * triggered it); defaults to `false` otherwise. Only consulted when
   * `autoCreatePR` is on.
   */
  readonly skipReviewerRequest?: boolean;
  /** Short-lived session env vars passed to the cloud VM. */
  readonly envVars?: Record<string, string>;
  /** Cloud env selector. Default: `{ type: "cloud" }` (Cursor-managed). */
  readonly env?: { readonly type: "cloud" | "pool" | "machine"; readonly name?: string };
}
```

`CloudRunSpec` is re-exported from `@ship/cursor-runner` for callers in `@ship/core` / `@ship/mcp-server` (same ED-3 boundary as phase 03's `AgentDefinition`).

When `runtime === "cloud"` and `cloud` is undefined, `CloudCursorRunner.run` throws `MissingCloudSpecError` synchronously before any SDK call. When `runtime === "local"` (or omitted) and `cloud` is set, the value is silently ignored by `LocalCursorRunner` — additive optional fields don't break existing callers.

### F3 — `ShipService` routes between runners by `input.runtime`

`createShipService` accepts both runners at construction:

```ts
// packages/core/src/service.ts
export interface ShipServiceConfig {
  // ...existing fields...
  readonly cursor: CursorRunner;       // existing — defaults to LocalCursorRunner
  readonly cloudCursor?: CursorRunner; // NEW — CloudCursorRunner; required to accept cloud runs
}
```

`ShipService.ship(input)` selects:

- `input.runtime === "cloud"` → `config.cloudCursor` (throws `CloudRunnerNotConfiguredError` if undefined).
- `input.runtime === "local"` or omitted → `config.cursor` (existing path, unchanged).

`default-wiring.ts` constructs both runners by default:

```ts
const cursor = opts.cursor ?? new LocalCursorRunner();
const cloudCursor = opts.cloudCursor ?? new CloudCursorRunner();
```

Production callers (CLI, mcp-server) get both wired without opt-in. Tests / fakes can pass `cloudCursor: undefined` to assert the not-configured error path.

### F4 — Cloud runs default to `autoCreatePR: true`; symmetric `open_pr` integration is a follow-up phase

**Correction from revision 1:** the prior draft said cloud `autoCreatePR` defaults to `false` and falls through to `open_pr`. That was wrong. `open_pr`'s implementation ([packages/core/src/open-pr.ts:235](../../../../packages/core/src/open-pr.ts) `resolveHead`) reads the branch name from the local worktree's branch (`worktree.branch` or a fallback `git rev-parse`) — there is no path today for `open_pr` to discover a cloud-produced branch, because cloud runs have no local checkout the branch lives in. Codex caught this in cycle-2.

**Revised choice:** cloud runs default to `cloud.autoCreatePR: true`. The cloud VM opens the PR itself; the caller's flow is `ship.ship` → done. Local runs continue to use the explicit `open_pr` flow unchanged.

This produces an intentional asymmetry between runtimes this phase:

| Runtime | Canonical flow | Why |
|---|---|---|
| local | `ship.ship` → `open_pr` | Status quo. `open_pr` reads the local worktree's branch. |
| cloud | `ship.ship` (`autoCreatePR: true`) → done | Cloud VM opens the PR. No need to round-trip through `open_pr`. |

Callers that want `cloud + explicit open_pr` (e.g. to inspect the diff locally before opening) cannot use that flow until the follow-up phase lands. That phase (call it "open_pr cloud-aware") needs:

- A new `cursor_runs.branches_json` column (0002 migration) so the cloud-produced branch info is persisted.
- `CloudCursorRunner` writes `result.git.branches` to the new column on terminal.
- `open_pr.resolveHead` becomes runtime-aware: for `cursor_runs.runtime === "cloud"`, read from `cursor_runs.branches[0].branch` instead of `worktree.branch`.
- L3 scenarios exercising the cloud-then-explicit-open_pr flow.

Filing the follow-up under the same dossier phase (`v2-cursor-cloud-runner`) as a separate task rather than expanding this phase's scope. Keeps phase 04's impl PRs in the "amazing" band.

`cloud.autoCreatePR: false` is still accepted as input (caller may want to disable the auto-PR for non-PR-producing runs); when used, Ship records the cloud-produced branch in `events.ndjson` via the `result.git.branches` data (no new persistence) and the operator can manually open the PR via `gh pr create` from the cloud-pushed remote until the follow-up phase lands.

### F5 — Subagents in cloud: file-based via repo commit, inline via `CursorRunInput.agents`

Cloud agents do not load `.cursor/agents/*.md` via `settingSources` (SDK limitation). Two paths still work:

1. **File-based.** `.cursor/agents/*.md` committed to the repo. Cloud clones the repo into its VM at `startingRef`; the SDK picks up the files at create time per its documented cloud-side loading path.
2. **Inline.** `CursorRunInput.agents` (phase 03's existing field) passes through to `Agent.create({ agents })` unchanged. Same precedence rule applies (inline overrides file-based at same key).

The Ship-repo `.cursor/agents/code-reviewer.md` set already committed in phase 03 + #41 + #43 + #49 will exercise the file-based path on the first Ship-on-Ship cloud run. No new dogfood asset required.

### F6 — Branch / PR discovery via `result.git.branches`

The interface already exposes this surface; `LocalCursorRunner` populates `CursorRunResult.branches` with `result.git?.branches ?? []` (always empty for local). Cloud runs populate it for real.

**Persistence**, **correction from revision 1**: branches are NOT persisted to a `cursor_runs` column today — `cursor_runs` has no `branches_json` column. The cloud-produced branch info flows through `onEvent` → `events.ndjson` (per F7) and is available to any reader of the run's `events.ndjson` artifact. Adding a structured `cursor_runs.branches_json` column is the follow-up phase's job (see F4); this phase keeps the schema unchanged.

When a cloud run sets `autoCreatePR: true` (the default per F4), `branches[0].prUrl` is populated by the SDK and visible in `events.ndjson` alongside `branches[0].branch`. When `autoCreatePR: false`, only `branches[0].branch` is populated — the operator can use it to manually open the PR until the follow-up phase enables `open_pr` to read the cloud branch.

### F7 — Cloud-specific events stream through unchanged

`onEvent` already accepts opaque `SDKMessage`. Cloud-specific event types (`status: CREATING | RUNNING | FINISHED | ERROR | CANCELLED | EXPIRED`, plus `task` and `request` events the SDK doc describes for cloud) flow through to `events.ndjson` without transformation. No new code; the existing pipeline is event-type-agnostic.

The artifact reader (`packages/core/src/artifacts/`) treats `events.ndjson` as opaque NDJSON for downstream consumers; cloud-specific events are visible there without modification.

### F8 — `IntegrationNotConnectedError` → actionable Ship error

The SDK throws `IntegrationNotConnectedError` (with `provider` + `helpUrl` fields) when a cloud agent targets a repo whose SCM isn't connected to the calling user's Cursor account. This is a setup error, not a code error, and the operator can resolve it by visiting `cursor.com/dashboard/integrations/<provider>`.

`CloudCursorRunner` catches this in `#startAgent`'s existing error wrapper and rethrows as `CursorCloudIntegrationError extends CursorRunFailedError` with the provider + helpUrl preserved. The MCP tool layer maps the typed error to `isError: true` with a message that includes the helpUrl verbatim (so the operator can click through from their MCP client).

### F9 — Cancellation propagates to the cloud VM

`run.cancel()` is documented to work for cloud runs as well as local. The existing `LocalCursorRunner` cancel pipeline (idempotent via `terminated` + `cancelInitiated`) handles the higher cloud latency transparently. `CloudCursorRunner` reuses the same shape.

Edge case: if the user cancels during the cloud VM's CREATING phase (before the agent is actually running), the SDK behavior is ambiguous in the reference. Validation plan includes an L3 scenario that exercises this case.

## Non-functional requirements

- **Backwards-compatible at every layer.** No SQL schema changes. No new MCP tool. `ship.ship` accepts two new optional input fields (`runtime`, `cloud`); existing callers omitting them keep their existing local-runner behavior.
- **No new SDK dependency.** `@cursor/sdk` is already a direct dep of `@ship/cursor-runner`. Cloud surface is a different API surface inside the same package.
- **Workspace-agnostic posture preserved.** Cloud runs don't require Tower or a local worktree at all (the VM clones the repo). For mixed-mode flows where local-side work needs to land first, the operator still uses Tower for the local worktree; the cloud run reads from the repo's git state, not from the local checkout.
- **Strict TS + lint matching the rest of the repo.** No relaxations. The discriminated-union complexity stays at the runner boundary; `ShipService` and the MCP layer code against `input.runtime?: "local" | "cloud"` as a plain optional discriminant.
- **Tests at every changed layer.** Unit tests for `CloudCursorRunner.run` against a `FakeCursor` substitute; integration test for `ShipService` routing by runtime; L3 (live, opt-in) scenario for a real cloud run.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Runtime selection mechanism | `CursorRunInput.runtime: "local" \| "cloud"` discriminant + optional `cloud: CloudRunSpec` | Split into two interfaces (`LocalCursorRunInput` / `CloudCursorRunInput`) with a tagged union | Splitting forces every caller in `@ship/core` to handle the union when constructing input. The flat discriminant keeps existing call sites unchanged while still validating shape at the runner boundary. SDK precedent: `Agent.create({ local })` vs `Agent.create({ cloud })` uses optional discriminator fields on the same arg shape. |
| `CloudCursorRunner` placement | Same package (`@ship/cursor-runner`), new file `cloud-runner.ts` | Separate package (`@ship/cursor-cloud-runner`) | One SDK seam, one ED-2 import-isolation boundary. Splitting into two packages duplicates the import-isolation test, the build target, and the package.json publishing story for a one-class addition. |
| Default `autoCreatePR` for cloud | `true` (cloud VM opens its own PR; `ship.ship` → done) | `false` (call `open_pr` after, symmetric with local) | **Revised from rev 1.** `open_pr` reads the local worktree's branch via `resolveHead` ([open-pr.ts:235](../../../../packages/core/src/open-pr.ts)); cloud runs have no local branch to read. Making `open_pr` cloud-aware needs a new `cursor_runs.branches_json` column + runtime-aware `resolveHead` + L3 scenarios — out of scope this phase. Default `autoCreatePR: true` gives cloud a working end-to-end loop today; the symmetric `cloud + explicit open_pr` flow lands in the follow-up phase. |
| `EXPIRED` mapping | → `cancelled` | → `failed` | EXPIRED means the platform terminated the run — the agent didn't error, didn't finish, was stopped externally. `cancelled` is closer in vocabulary; `failed` implies the agent's work itself errored. The terminal-state classification has practical impact (open_pr won't fire on failed/cancelled — see phase 02 § F3). |
| Cloud auth source | SDK-default (CURSOR_API_KEY env var, account-level repo connections) | Per-run override fields | The SDK already handles auth via the API key. SCM connection is account-level; per-run override would duplicate Cursor's dashboard. F8 surfaces the right error when the connection isn't set up. |
| Subagents in cloud | File-based (commit `.cursor/agents/*.md` to the repo) + inline via existing `CursorRunInput.agents` | Plumb `settingSources` analog through cloud | SDK doc explicitly says `local.settingSources` doesn't apply to cloud. Cloud reads the repo it clones; committed `.cursor/agents/*.md` is the natural file-based path. The existing inline path works unchanged. |
| `Agent.resume` in scope this phase | No | Yes — model resume in `CursorRunHandle` | Resume requires redesigning `CursorRunHandle.result` (currently a one-shot promise) into something resumable. That's a real interface change with broader implications (workflow state, cancellation across resumes). Cloud-without-resume is still substantial value; resume is a follow-on phase. |
| Artifact pickup in scope this phase | No | Yes — wire `listArtifacts` / `downloadArtifact` | No existing Ship surface for artifacts. Adding one requires a `cursor_runs.artifacts_json` column, a new MCP tool or input shape, and a security story (cloud delivers arbitrary file content). Defer; dogfood will show whether artifacts are needed at all or if `result.git.branches` covers the use cases. |

## Engineering decisions

### ED-1 — `CloudCursorRunner` is a sibling to `LocalCursorRunner`, not a refactor of it

`LocalCursorRunner` stays unchanged. `CloudCursorRunner` is a new class in a new file with the same shape but its own `Agent.create` config, its own `EXPIRED`-status mapping, and its own error wrapping for `IntegrationNotConnectedError`.

Helpers that are genuinely shared can be extracted into a `_shared.ts` file, but **only if** an extraction has a clean home — premature DRY between two impls of a runtime-specific class adds shared state for one consumer each (samurai-sword from `feedback_samurai_sword.md`).

**Default: extract `mapRunResult` + `mapTerminalResult`** into `packages/cursor-runner/src/_shared.ts` — ED-5's snippet implies the cross-file call (`mapCloudRunResult` reuses `mapRunResult`'s `finished` / `cancelled` / `error` branches verbatim), and two consumers is the clean-home bar. The cancel pipeline, `isPromiseLike`, `safelyEmit`, and the dispose-in-finally pattern are LESS obvious candidates — leave their extraction to the implementation PR's judgement against the actual code shape.

### ED-2 — `runtime` + `cloud` are optional on `CursorRunInput`, validated by the runner

The type system stays simple — `runtime?: "local" | "cloud"` and `cloud?: CloudRunSpec` are both optional. The cloud runner's `run()` method validates:

- `input.runtime` is either undefined or `"cloud"` (`LocalCursorRunner` does the symmetric check; cloud-mode input passed to local-runner throws).
- `input.cloud` is defined and has at least one `repos` entry.

A discriminated union at the type level (`input.runtime extends "cloud" → input.cloud is required`) is *possible* but propagates the union into every signature touching `CursorRunInput`. The validation-at-boundary approach keeps the rest of the codebase free of conditional type narrowing.

### ED-3 — `CloudRunSpec` is re-exported from `@ship/cursor-runner`

Per V1 phase 05 ED-2, only `@ship/cursor-runner` imports `@cursor/sdk`. Callers in `@ship/core` / `@ship/mcp-server` constructing `CursorRunInput.cloud` need the type; the runner re-exports it (same pattern as phase 03's `AgentDefinition` re-export):

```ts
// packages/cursor-runner/src/index.ts
export type { CloudRunSpec } from "./runner.js";
```

The `CloudRunSpec` shape is defined in `runner.ts` (Ship's vocabulary) rather than re-exporting `CloudOptions` from `@cursor/sdk` directly — Ship's shape is a subset and validates at the boundary; the SDK's shape may carry experimental fields we don't want to expose without explicit opt-in.

### ED-4 — `ShipService` config grows `cloudCursor?: CursorRunner`

`ShipServiceConfig.cursor` stays required (existing). `ShipServiceConfig.cloudCursor` is added as optional. When `input.runtime === "cloud"` and `cloudCursor` is undefined, `ShipService.ship` throws `CloudRunnerNotConfiguredError` before any persistence. Tests can opt out of cloud wiring by leaving the field undefined.

`default-wiring.ts` constructs both runners by default. The CLI / MCP server bind both at startup without conditional wiring.

### ED-5 — `EXPIRED` maps to `cancelled`, not `failed`

The `mapRunResult` helper in `local-runner.ts:241` (moving to `_shared.ts` per ED-1) switches on `result.status`; the cloud equivalent grows one branch:

```ts
function mapCloudRunResult(result: RunResult, input: CursorRunInput): CursorRunResult {
  // SDK casing TBD — verify in impl PR. F1 / F7 quote the cloud status enum
  // as `EXPIRED` (uppercase); `local-runner.ts:243` reads `result.status` and
  // matches against lowercase `"finished"` / `"cancelled"` (Ship-side
  // vocabulary derived from the SDK's terminal mapping). Check
  // `RunResult.status` directly in the impl PR before wiring the guard;
  // adjust casing if needed.
  if (result.status === "expired") return mapTerminalResult(result, "cancelled");
  return mapRunResult(result, input);  // same as local for finished/cancelled/error
}
```

Rationale (also in Tradeoffs): EXPIRED is platform-side termination, not agent-side error. The `cancelled` terminal won't trigger `open_pr` (per phase 02 § F3 step 2), which matches operator intent — an expired run's branch may be partial.

If `failed` would be operationally preferable (e.g. monitoring distinguishes expired-vs-cancelled with different alerts), a separate `cursor_runs.terminal_reason` column could record the SDK status without changing the `status` mapping. Out of scope for this phase.

### ED-6 — `ship.ship` MCP input gains `runtime` + `cloud` fields

The MCP tool schema (`shipInputSchema`) grows two optional fields. Both are additive; existing MCP clients ignore them.

```ts
const cloudSpecSchema = z.object({
  // Single-repo tuple this phase (OQ #3 resolution). `z.tuple(...)` infers
  // a single-element tuple type matching `CloudRunSpec.repos: readonly [{...}]`
  // — `z.array(...).length(1)` would infer a plain array and require a cast
  // at the runner boundary. Multi-repo opens a follow-up phase that addresses
  // workflowRun.workdir semantics.
  repos: z.tuple([
    z.object({
      url: z.string().url(),
      startingRef: z.string().optional(),
      prUrl: z.string().url().optional(),
    }),
  ]),
  workOnCurrentBranch: z.boolean().optional(),
  autoCreatePR: z.boolean().optional(),
  skipReviewerRequest: z.boolean().optional(),
  envVars: z.record(z.string()).optional(),
  // "pool" / "machine" pass through to the SDK but Ship doesn't provide
  // operator-side support for self-hosted env configuration this phase
  // (Out-of-scope). Schema accepts them so power-users can wire their own.
  env: z.object({
    type: z.enum(["cloud", "pool", "machine"]),
    name: z.string().optional(),
  }).optional(),
});

const shipInputSchema = z.object({
  // ...existing fields...
  runtime: z.enum(["local", "cloud"]).optional(),
  cloud: cloudSpecSchema.optional(),
});
```

CLI mirror: `ship ship --runtime cloud --cloud-repo <url>` opt-in. Cloud-specific fields aren't all expressible as flags ergonomically (envVars, the `env.type` enum) — for the CLI, expose `--cloud` as a JSON-file pointer (`--cloud cloud-config.json`) for power-user flows, and a small set of flags for the common case (`--cloud-repo`, `--cloud-auto-create-pr`).

### ED-7 — Cloud-specific errors extend the existing `CursorRunFailedError` hierarchy

New error types:

- `MissingCloudSpecError extends CursorRunFailedError` — `runtime: "cloud"` without a `cloud` input field. Thrown synchronously before any SDK call.
- `CloudRunnerNotConfiguredError extends CursorRunFailedError` — Ship wasn't constructed with `cloudCursor`. Thrown by `ShipService.ship` before persistence.
- `CursorCloudIntegrationError extends CursorRunFailedError` — wraps the SDK's `IntegrationNotConnectedError`, preserves `provider` + `helpUrl`.

All three map to MCP `isError: true` responses with the typed message; the MCP tool's existing error-mapping pattern handles new error types via subclass detection.

### ED-8 — Persistence: cloud runs share `cursor_runs` with local runs

No new table, no new column. The existing `cursor_runs` row (V1 schema, [0001_init.sql:44-55](../../../../packages/store/migrations/0001_init.sql)) records `id`, `workflow_run_id`, `agent_id`, `runtime`, `model_json`, `status`, `started_at`, `ended_at`, `duration_ms`, `artifacts_dir`. Cloud runs write the same shape; `runtime` is set to `"cloud"` instead of `"local"`.

**Correction from revision 1:** the previous draft claimed `cursor_runs.runtime` would be a future-add. The column already exists — codex caught this in cycle-2. The V1 schema landed with it; existing rows all have `runtime: "local"`. This phase just adds the `"cloud"` value to the set of values produced.

**What does NOT get persisted this phase:** `CursorRunResult.branches` (cloud-produced branch info from `result.git.branches`). There is no `branches_json` column today, and this phase doesn't add one. Cloud branch info flows through `onEvent` → `events.ndjson` (per F7) and is readable there. Structured persistence is the follow-up "open_pr cloud-aware" phase's responsibility — it needs the column to make `open_pr.resolveHead` runtime-aware. See Out-of-scope.

The agentId prefix (`bc-` vs `agent-`) is a redundant eyeball-marker; the explicit `runtime` column is authoritative. Querying by `cursor_runs.runtime = 'cloud'` is the supported shape.

## Validation plan

### Unit tests (Vitest)

- `cursor-runner`: `CloudCursorRunner.run` calls `Agent.create` with `cloud: {...}` and not `local: {...}`.
- `cursor-runner`: `CloudCursorRunner.run` throws `MissingCloudSpecError` when `input.runtime === "cloud"` and `input.cloud` is undefined.
- `cursor-runner`: `LocalCursorRunner.run` throws when `input.runtime === "cloud"` (sanity — wrong runner for input).
- `cursor-runner`: `EXPIRED` status maps to `cancelled` terminal.
- `cursor-runner`: `IntegrationNotConnectedError` from SDK wraps as `CursorCloudIntegrationError` with provider + helpUrl preserved.
- `cursor-runner`: import-isolation test extended to permit `CloudRunSpec` re-export from `@ship/cursor-runner`.
- `core`: `ShipService.ship` routes to `cloudCursor` when `input.runtime === "cloud"`; throws `CloudRunnerNotConfiguredError` when unconfigured.
- `mcp-server`: `shipInputSchema` accepts `runtime: "cloud"` + `cloud: {...}`; rejects malformed cloud specs at the parse boundary.

### Integration tests

- `e2e` (L2 — `FakeCursor`-substituted): `ShipService.ship({ runtime: "cloud", cloud: { repos: [...], autoCreatePR: true } })` runs end-to-end with a fake cloud runner; `cursor_runs.runtime === "cloud"` is asserted; the fake's `result.git.branches` flows through `events.ndjson` and is readable via `get_workflow_run`.
- `e2e` (L2): `ShipService.ship` rejects `runtime: "cloud"` when `cloudCursor` is unconfigured (asserts the `CloudRunnerNotConfiguredError` path before any persistence). Symmetric to the existing local-only test.

### L3 (live e2e, opt-in via `SHIP_LIVE=1` + `SHIP_CLOUD=1`)

Three new scenarios under `e2e/scenarios/cloud-*.e2e.test.ts`:

1. **Happy path with `autoCreatePR: true`.** Cloud run against a test repo with the default `autoCreatePR: true`; assert `result.git.branches[0].branch` and `result.git.branches[0].prUrl` are both populated; assert the PR was created on the test repo (via `gh pr view <prUrl>`); assert `events.ndjson` carries the branch + PR info.
2. **`autoCreatePR: false` flow.** Cloud run with `autoCreatePR: false`; assert `result.git.branches[0].branch` is populated and `prUrl` is undefined; assert the run terminates `succeeded`. (The "explicit `open_pr` against the cloud branch" path is deferred to the follow-up phase — this scenario just verifies the partial-mode persists correctly.)
3. **Cancellation during CREATING.** Cloud run is cancelled before the SDK transitions to RUNNING; assert the terminal status is `cancelled`; assert no orphan agent left on the Cursor side (verify via `Agent.list({ runtime: "cloud" })`).

The double gate (`SHIP_LIVE=1` + `SHIP_CLOUD=1`) is intentional — cloud runs cost both Cursor credits and real GitHub branches on a test repo. Local L3 scenarios stay under `SHIP_LIVE=1` only.

### Acceptance for the phase

- This PR (this design doc + spec.md amendment) merged on main via inline review (no design-PR ceremony).
- Implementation PR(s) follow per § Implementation plan. Each merges with `make check` green.
- One Ship-on-Ship cloud run lands (against the Ship repo itself or a test repo) and is recorded as evidence in the final impl PR's description.
- L2 fake-cursor scenario added in the integration-test PR; L3 scenarios gated on `SHIP_LIVE=1 + SHIP_CLOUD=1`.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cursor cloud SDK behavior drifts from the reference between design and impl | Implementation deviates from the design contract; tests pin the wrong shape | Re-run a small cloud spike (similar to spike findings in `cursor-sdk-typescript.md`) at the start of the impl PR; capture observed shape inline; adjust this doc only if drift is material. |
| Cloud runs incur unexpected cost / quota usage | Operator opens too many cloud agents (e.g. parallel-driver against N PRs all cloud); blows through credits | Default `runtime: "local"`. Opt-in only. Document the cost note in the impl PR's changelog. Future leverage doc Tier 1 #2 (token-usage tracking) lands cost reporting per run. |
| `IntegrationNotConnectedError` surfaces in a way the operator can't act on | Operator sees a generic "SDK failed" error; doesn't know to visit cursor.com/dashboard/integrations | F8 + ED-7 wrap into `CursorCloudIntegrationError` with the `helpUrl` preserved through MCP responses. |
| Cloud agent leaks (created but never terminated) on a crashed Ship process | Orphan agents accumulate on the Cursor side; operator's `Agent.list` clutter; possible quota impact | Existing `agent[Symbol.asyncDispose]()` in the runner pipeline handles graceful exit. For ungraceful exits, document the cleanup recipe (`Agent.list({ runtime: "cloud" })` + `Agent.archive` / `delete`) in the impl PR's "Troubleshooting" section. A future "cloud agent reconciliation" task could automate this — out of scope here. |
| `EXPIRED` mapping to `cancelled` confuses operators expecting `failed` | Monitoring dashboards / alerting rules mis-classify expired runs | ED-5 captures the rationale; the impl PR's changelog calls out the mapping explicitly. If operationally confusing, a follow-up adds `cursor_runs.terminal_reason` without changing the `status` field. |
| Cancellation during cloud CREATING phase behaves differently than RUNNING | Cancel signal lost; cloud agent runs to completion despite user intent | Validation L3 scenario (3) exercises this; if SDK behavior is broken, file a chip + document the gap in this doc; ship the feature anyway (cancellation during RUNNING is the common case). |
| `autoCreatePR: true` opens a PR before the operator wants it (e.g. work in progress) | Premature PR notification spam; CI fires on incomplete work | Default `autoCreatePR: false`. Document in the impl PR that opt-in to `true` is for known-complete runs only. |
| Cloud-specific event types break a downstream events.ndjson reader | Reader code assumes only `assistant` / `thinking` / `tool_call` / `status` event types (per V1 spike findings) | F7 says events stream unchanged. Any reader treating events.ndjson as opaque NDJSON is unaffected. Readers that switch on event type need to handle new types gracefully (per V1 ED-5 — events are forward-additive). |

## Out of scope

- **`Agent.resume` for cloud runs across Ship process restart.** Cloud agents survive process death; Ship could in principle re-attach to a mid-run cloud agent after a restart. Requires redesigning `CursorRunHandle.result` (currently a one-shot promise) and persistence of the SDK agent id beyond the run record. Follow-up phase.
- **Artifact pickup (`agent.listArtifacts` / `downloadArtifact`).** Cloud-only feature; no existing Ship surface for non-git deliverables. Defer until dogfood proves the use case.
- **GUI / browser testing via the cloud VM's desktop environment.** [docs/cursor-sdk-typescript.md § Why cloud runtime matters](../../../cursor-sdk-typescript.md) flags this as a long-term unlock; not in this phase's scope. Adjacent: passing `playwright-mcp` via `CursorRunInput.mcpServers` works today for both runtimes.
- **Self-hosted cloud env (`env.type: "machine"` / `"pool"`).** Schema admits these values (F2 / ED-6), but Ship doesn't ship a self-hosted setup. Operator-config-driven; no Ship-side support code beyond the field passing through to the SDK.
- **Multi-repo cloud runs.** Single-repo enforced this phase via `cloud.repos` as a single-element tuple (`.tuple([...])` in the schema). Ship's `workflowRun.workdir` model is single-repo-per-run; multi-repo opens a follow-up phase that addresses what `workdir` means when work spans repos. The SDK admits an array; Ship narrows at the boundary.
- **`workOnCurrentBranch: true`.** Cloud can push to an existing branch instead of creating a new one — useful for iteration on a PR that's already open. The flag passes through, but the workflow shape (one run = one new branch) doesn't anticipate it. Document as "experimental, no Ship-side guarantees" in the impl PR; promote to first-class in a follow-up if dogfood needs it.
- **Cloud agent lifecycle management UI / CLI subcommands.** `Agent.archive` / `unarchive` / `delete` are SDK primitives; Ship doesn't surface them as MCP tools or CLI subcommands this phase. Operator uses `cursor` CLI directly if cleanup is needed.
- **`open_pr` cloud-aware integration.** Today's `open_pr` ([open-pr.ts:235](../../../../packages/core/src/open-pr.ts) `resolveHead`) reads the head branch from the local worktree only. For cloud runs, the branch only exists on the remote (no local worktree to read from). Wiring `open_pr` to read `cursor_runs.branches[0].branch` for `runtime === "cloud"` rows needs: a new `cursor_runs.branches_json` column (0002 migration), `CloudCursorRunner` persistence of `result.git.branches`, runtime-aware `resolveHead`, and L3 scenarios. Filed as a follow-up phase. Until it lands, cloud runs use `autoCreatePR: true` (default) for the end-to-end PR flow.

## Open questions

These should be resolved in the operator's inline review before the impl PR starts.

1. **Should `default-wiring.ts` construct `CloudCursorRunner` eagerly, or lazily on first cloud-mode `ship.ship` call?** Eager (per ED-4 default) keeps wiring simple but constructs the cloud client even for users who never run cloud. Lazy adds a factory layer but avoids the cost. Default proposal: eager — the `CloudCursorRunner` constructor itself is cheap (no network), only `Agent.create` is.
2. **Does the CLI need `ship ship --runtime cloud` flags exposed, or only the MCP tool?** ED-6 proposes both; the operator may want CLI parity deferred to a separate small PR.
3. ~~**Should `cloud.repos` accept the SDK's full shape (multiple repos) or restrict to a single repo this phase?**~~ **Resolved:** restrict to a single repo this phase via Zod `.length(1)` (see F2 / ED-6). Multi-repo opens a follow-up phase that addresses `workflowRun.workdir` semantics for multi-repo; the SDK admits the array, but Ship's row shape doesn't anticipate it. Out-of-scope row updated.
4. ~~**Where does `CURSOR_API_KEY` come from for cloud runs in the mcp-server context?**~~ **Resolved:** cloud and local both read `process.env.CURSOR_API_KEY`. For mcp-server processes run as a service, env injection is operator-side. No Ship-side change; impl PR's changelog documents the requirement.
5. ~~**Should cloud runs default to `skipReviewerRequest: true`?**~~ **Resolved:** `skipReviewerRequest` defaults to `autoCreatePR === true` (skip when Ship-flagged auto-PR is on, since Ship's caller already knows about the PR they triggered). When `autoCreatePR === false` (the canonical flow), `skipReviewerRequest` defaults to `false` and is moot — `open_pr`'s own reviewer-request behavior governs. F2 JSDoc reflects the conditional default.
6. **What's the dogfood plan?** Once impl lands, the natural first cloud run is `ship.ship` against the Ship repo itself for a small phase task (e.g. one of the V3 backlog items in `tsk_01KRVAJVYJDT9Z7Q6A7H53RYWC`'s body). Confirms F1–F8 end-to-end and produces real PR + branch evidence.
6. ~~**Is the `EXPIRED → cancelled` mapping the right call, or should it be its own terminal state?**~~ **Resolved:** `cancelled` per ED-5 (platform-side termination, not agent-side error). If monitoring needs to distinguish expired-vs-cancelled with different alerts, a separate `cursor_runs.terminal_reason` column lands as a follow-up — escape hatch is in ED-5.

7. **`cloud + explicit open_pr` flow** — confirmed deferred to a follow-up phase per F4 + Out-of-scope. No operator decision required this phase, but flag here for visibility: callers who want `cloud + autoCreatePR: false + open_pr` cannot use that combination until the follow-up lands.

## Implementation plan

After this design doc + spec.md amendment is reviewed and merged, the impl lands as a sequence of PRs. Each is sized to the "amazing" band per CLAUDE.md.

1. **`CloudCursorRunner` skeleton + interface extensions.** ~140 src + ~280 tests (0.5×) = **~280 weighted LOC.** Adds the new class, the `CloudRunSpec` interface + re-export, the `runtime` / `cloud` optional fields on `CursorRunInput`, the new error types (ED-7), and unit tests for `Agent.create` shape + error paths. No `ShipService` changes yet — `CloudCursorRunner` exists but isn't wired.
2. **`ShipService` routing + default wiring.** ~80 src + ~160 tests (0.5×) = **~160 weighted LOC.** Adds `ShipServiceConfig.cloudCursor`, the `input.runtime` routing in `ShipService.ship`, the `CloudRunnerNotConfiguredError`, and the default-wiring construction of both runners.
3. **`ship.ship` MCP schema + handler.** ~50 src + ~100 tests (0.5×) = **~100 weighted LOC.** Extends `shipInputSchema` with `runtime` + `cloud`; adds error mapping for the three new error types; adds parameterized integration scenarios (L2) over the two runtimes.
4. **CLI flags + `--cloud cloud-config.json` flow.** ~40 src + ~80 tests (0.5×) = **~80 weighted LOC.** Adds `--runtime`, `--cloud-repo`, `--cloud-auto-create-pr`, `--cloud` (JSON file) to the `ship ship` subcommand.
5. **L3 cloud scenarios.** ~30 src + ~60 tests (0.5×) = **~60 weighted LOC.** The three scenarios from Validation § L3, gated on `SHIP_LIVE=1 + SHIP_CLOUD=1`.
6. **Dogfood + impl-PR description evidence.** Land one real Ship-on-Ship cloud run; capture the evidence (workflowRunId, branch, PR url, `events.ndjson` snippet) in the final impl PR's description. Closes the phase's acceptance criteria.

Estimated cumulative weighted budget across the 5 code PRs: ~680 LOC. Each PR fits "amazing"; the bundle would not, by design.

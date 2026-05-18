# Phase 04 impl PR #1 — `CloudCursorRunner` skeleton + `CursorRunInput` extensions

Status: ready-to-ship — input to `ship.ship` after [phase 04 design](04-cursor-cloud-runner.md) merges.
Owner: itsHabib
Date: 2026-05-18

> **Companion docs.** Parent design: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md) — read its § F1 (four-divergence list), § F2 (interface extensions), § ED-1 (`_shared.ts` extraction), § ED-5 (`EXPIRED → cancelled`), § ED-7 (typed errors), § Implementation plan step 1.
> Dossier task: `tsk_01KRWENX967Q6F9A8QJ87PB1W3` (`v2-cursor-cloud-runner` phase).
> Prior art for pipeline shape: [`packages/cursor-runner/src/local-runner.ts`](../../../../packages/cursor-runner/src/local-runner.ts).
> Test pattern to mirror: `packages/cursor-runner/test/` (FakeCursor substitute; no real SDK in unit tests).

## Scope

**Weighted-LOC budget: ~280 weighted (~140 src + ~280 tests at 0.5×). "Amazing" band.** Do not exceed 500 weighted.

## Goal

Land `CloudCursorRunner` as a constructible class with the right shape, alongside the `CursorRunInput` field extensions (`runtime?`, `cloud?`) and the `CloudRunSpec` interface. The class exists and is unit-tested against a `FakeCursor` substitute, but `default-wiring.ts` does not yet construct it — that's the next PR.

## Functional requirements

### F1 — New file `packages/cursor-runner/src/cloud-runner.ts`

Class `CloudCursorRunner implements CursorRunner`. Mirror `LocalCursorRunner`'s shape — same `run()` entry, same `#startAgent` / `#buildHandle` / `#runPipeline` / `#tryWait` internal methods, same cancel idempotency via `terminated` + `cancelInitiated` guards, same dispose-in-finally cleanup.

Four divergences from local (per design § F1):

1. **`Agent.create` config.** Pass `cloud: { ... }` instead of `local: { cwd, settingSources }`. Field mapping from `CursorRunInput.cloud` (validated per F3):
   ```ts
   cloud: {
     repos: input.cloud.repos,
     ...(input.cloud.workOnCurrentBranch !== undefined && { workOnCurrentBranch: input.cloud.workOnCurrentBranch }),
     ...(input.cloud.autoCreatePR !== undefined && { autoCreatePR: input.cloud.autoCreatePR }),
     ...(input.cloud.skipReviewerRequest !== undefined && { skipReviewerRequest: input.cloud.skipReviewerRequest }),
     ...(input.cloud.envVars !== undefined && { envVars: input.cloud.envVars }),
     ...(input.cloud.env !== undefined && { env: input.cloud.env }),
   }
   ```
   Mirror `LocalCursorRunner`'s `exactOptionalPropertyTypes`-safe spread pattern for optional fields.
2. **No `settingSources` clause.** SDK doc explicitly says `local.settingSources` does not apply to cloud agents. Cloud reads `.cursor/agents/*.md` and `.cursor/mcp.json` from the repo the VM clones, not from a local cwd.
3. **`EXPIRED` status maps to `cancelled`.** Local's `mapRunResult` switch handles `finished` / `cancelled` / others-as-failed. Cloud's wrapper (or the extracted shared helper — see F2) handles `expired` first, returning a `cancelled` terminal. Rationale (per design § ED-5): EXPIRED is platform-side termination, not agent-side error.
4. **`IntegrationNotConnectedError` wraps as `CursorCloudIntegrationError`.** Catch in `#startAgent`'s existing pre-run-failure block; preserve `provider` + `helpUrl` from the SDK error onto the wrapper. Re-throw via the existing error pipeline. See F4.

### F2 — Extract `mapRunResult` + `mapTerminalResult` into `packages/cursor-runner/src/_shared.ts`

Per design § ED-1's stated default. `local-runner.ts` and the new `cloud-runner.ts` both import from `_shared.ts`. Cloud's mapper wraps the shared one with the `EXPIRED` branch:

```ts
// packages/cursor-runner/src/_shared.ts
export function mapRunResult(result: RunResult, input: CursorRunInput): CursorRunResult { /* moved verbatim */ }
export function mapTerminalResult(result: RunResult, status: "succeeded" | "cancelled"): CursorRunResult { /* moved verbatim */ }
export function mapErrorResult(result: RunResult, input: CursorRunInput): CursorRunResult { /* moved verbatim */ }
```

```ts
// packages/cursor-runner/src/cloud-runner.ts
import { mapRunResult, mapTerminalResult } from "./_shared.js";

function mapCloudRunResult(result: RunResult, input: CursorRunInput): CursorRunResult {
  if (result.status === "expired") return mapTerminalResult(result, "cancelled");
  return mapRunResult(result, input);
}
```

`isPromiseLike`, `safelyEmit`, and the cancel pipeline stay in `local-runner.ts` for now per design § ED-1's tightened guidance. Promote to `_shared.ts` only if the cloud impl needs them verbatim and the extraction has a clean home.

### F3 — Interface extensions in `packages/cursor-runner/src/runner.ts`

```ts
export interface CursorRunInput {
  // ...existing fields unchanged...

  /** Runtime selector. Defaults to "local" when omitted. */
  readonly runtime?: "local" | "cloud";

  /** Cloud-specific config. Required when runtime === "cloud"; ignored otherwise. */
  readonly cloud?: CloudRunSpec;
}

export interface CloudRunSpec {
  /**
   * GitHub repo the cloud agent operates against. Exactly one entry this
   * phase — multi-repo runs are out of scope.
   */
  readonly repos: readonly [{ readonly url: string; readonly startingRef?: string; readonly prUrl?: string }];
  /**
   * Push to existing branch instead of creating a new one. Default: false.
   * **Experimental** — the field passes through to the SDK but the
   * workflowRun-as-one-new-branch shape isn't designed for it.
   */
  readonly workOnCurrentBranch?: boolean;
  /** Auto-open a PR when the run finishes. Default: false (Ship's `open_pr` phase opens it). */
  readonly autoCreatePR?: boolean;
  /**
   * Skip requesting the calling user as PR reviewer. Defaults to `true` when
   * `autoCreatePR === true`; defaults to `false` otherwise. Only consulted
   * when `autoCreatePR` is on.
   */
  readonly skipReviewerRequest?: boolean;
  /** Short-lived session env vars passed to the cloud VM. */
  readonly envVars?: Record<string, string>;
  /** Cloud env selector. Default: `{ type: "cloud" }` (Cursor-managed). */
  readonly env?: { readonly type: "cloud" | "pool" | "machine"; readonly name?: string };
}
```

Validation at the runner boundary (per design § ED-2):

- `CloudCursorRunner.run`: throw `MissingCloudSpecError` synchronously when `input.runtime === "cloud"` and `input.cloud === undefined`. Throw `WrongRunnerError` (or similar — see F4) when `input.runtime === "local"` (this runner is cloud-only).
- `LocalCursorRunner.run`: throw `WrongRunnerError` (or similar) when `input.runtime === "cloud"`. When `input.runtime === "local"` or undefined, behave as today (default-local).
- The `input.cloud` field is silently ignored by `LocalCursorRunner` per the additive-optional-field design.

### F4 — Typed errors in `packages/cursor-runner/src/errors.ts`

Per design § ED-7. Three new error types:

```ts
export class MissingCloudSpecError extends CursorRunFailedError {
  constructor() {
    super("runtime: 'cloud' was set but input.cloud is undefined");
  }
}

export class CursorCloudIntegrationError extends CursorRunFailedError {
  constructor(
    public readonly provider: string,
    public readonly helpUrl: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Cloud agent integration not connected for provider "${provider}". Visit ${helpUrl} to connect.`,
      options,
    );
  }
}
```

(`CloudRunnerNotConfiguredError` is added in impl PR #2 — it's a `ShipService`-layer error, not a runner-layer error.)

A `WrongRunnerError` is recommended for the wrong-input-shape guards in F3. Naming-wise, either `WrongRunnerError` or `RuntimeMismatchError` works — pick the clearer one during implementation. It also extends `CursorRunFailedError`.

### F5 — Re-export `CloudRunSpec` + `CloudCursorRunner` from `@ship/cursor-runner`

```ts
// packages/cursor-runner/src/index.ts
export { CloudCursorRunner } from "./cloud-runner.js";
export type { CloudRunSpec } from "./runner.js";
```

Update the import-isolation test (`packages/cursor-runner/test/sdk-import-isolation.test.ts`) to permit `CloudRunSpec` as a type-only re-export. Pattern matches phase 03's `AgentDefinition` re-export precedent.

### F6 — Tests (Vitest)

Land all of the following in `packages/cursor-runner/test/cloud-runner.test.ts`:

- `CloudCursorRunner.run` calls `Agent.create` with the expected `cloud: {...}` payload — assert via `FakeCursor` mock that the args match the input mapping.
- `CloudCursorRunner.run` throws `MissingCloudSpecError` synchronously when `runtime: "cloud"` and `cloud` is undefined — assert via `expect(() => runner.run({ runtime: "cloud" })).rejects.toThrow(MissingCloudSpecError)`.
- `CloudCursorRunner.run` throws `WrongRunnerError` (or chosen name) when `runtime: "local"`.
- `EXPIRED` SDK status maps to `cancelled` terminal — assert through the terminal `CursorRunResult.status === "cancelled"`.
- SDK `IntegrationNotConnectedError` wraps as `CursorCloudIntegrationError` with `provider` + `helpUrl` preserved.

In `packages/cursor-runner/test/local-runner.test.ts` (existing file, add cases):

- `LocalCursorRunner.run` throws `WrongRunnerError` when `runtime: "cloud"`.
- `LocalCursorRunner.run` ignores `input.cloud` when `runtime` is unset/local.

In `packages/cursor-runner/test/sdk-import-isolation.test.ts`:

- Update the allow-list to permit `CloudRunSpec` (type-only) + `CloudCursorRunner` (runtime) re-exports.

Regression check: all existing `LocalCursorRunner` tests pass with the `_shared.ts` extraction in place.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| `_shared.ts` extraction scope | `mapRunResult` + `mapTerminalResult` + `mapErrorResult` | Also extract `isPromiseLike` / `safelyEmit` / cancel pipeline | Two mappers are obvious shared use; the rest are local-runner-shaped helpers cloud may not need verbatim. Avoid premature DRY (samurai-sword). |
| Wrong-runtime guard | Symmetric error types (`WrongRunnerError` on both runners) | Silently no-op cloud-input on local | Silent no-op surfaces bugs later (wrong runner wired, no-op never errors). Explicit error fails fast. |
| `input.cloud` ignored by local | Silently ignored | Validate + warn | Additive optional fields shouldn't generate warnings for callers that don't use them. Saves log noise. |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `Agent.create` cloud config drifts from SDK | Compile errors or runtime SDK errors | Validate locally against `@cursor/sdk` types; if any field's shape changed since the design (2026-05-18), capture the drift in the PR description and adjust before push. |
| `mapRunResult` extraction breaks existing local tests | Regression in `LocalCursorRunner` | Run `pnpm vitest run packages/cursor-runner` before commit; entire local suite must pass. |
| `EXPIRED` status doesn't actually exist in the SDK's `RunResult.status` enum | The mapping branch is dead code | Verify the SDK's `RunResult.status` includes `"expired"` (or whatever cloud uses); if not, document the gap in the PR description and either remove the branch or wire it from a different SDK field (e.g. `status` event). |
| Import-isolation test rejects the new re-export | CI red | Pattern is established by phase 03 (`AgentDefinition`); follow the same allow-list edit. |

## Out of scope (this PR)

- `ShipService` routing (impl PR #2).
- `default-wiring.ts` construction of `CloudCursorRunner` (impl PR #2).
- `ship.ship` MCP schema extension (impl PR #3).
- CLI flags (impl PR #4).
- L3 / live cloud scenarios (impl PR #5).
- Any `Agent.resume` / artifact / GUI / self-hosted / multi-repo work (out of scope at the phase level — design § Out of scope).

## Acceptance

- `make check` passes on ubuntu + windows CI.
- `pnpm vitest run packages/cursor-runner` green including all new cases.
- `new CloudCursorRunner()` is callable; the import-isolation test passes; the new re-exports show up in `@ship/cursor-runner`'s public API.
- Diff stays under 500 weighted LOC. PR description includes the actual weighted-LOC count + the design § F1's four-divergence checklist marked off.
- Commit trailer: `Co-authored-by: Cursor <cursoragent@cursor.com>` per repo convention.

## Implementation plan

1. Extract `mapRunResult` / `mapTerminalResult` / `mapErrorResult` into `_shared.ts`. Update `local-runner.ts` imports. Run existing tests — confirm green.
2. Extend `runner.ts` with `runtime` / `cloud` fields + the `CloudRunSpec` interface. Compiles only — no implementations yet.
3. Add new error types to `errors.ts` per F4.
4. Implement `cloud-runner.ts` mirroring `local-runner.ts`'s shape with the four divergences.
5. Add `cloud-runner.test.ts` covering F6's cloud-side tests.
6. Add the wrong-runner cases to `local-runner.test.ts`.
7. Update `index.ts` re-exports + `sdk-import-isolation.test.ts` allow-list.
8. `pnpm vitest run packages/cursor-runner` green.
9. `make check` green locally.
10. Commit + push. PR title: `feat(cursor-runner): CloudCursorRunner skeleton (phase 04 impl 1)`.

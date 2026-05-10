/**
 * `CursorRunner` — substrate-agnostic interface every consumer of the Cursor
 * SDK in Ship codes against.
 *
 * The whole point of this package is that `@cursor/sdk` is invisible to the
 * rest of the monorepo. Other packages (`core`, `mcp-server`, etc.) import
 * types from here — never from `@cursor/sdk` directly. ED-2's import-
 * isolation test enforces that property at CI time.
 *
 * V1 ships exactly one implementation: `LocalCursorRunner` (lands in 5b).
 * V2 will add `CloudCursorRunner` behind the same interface — substrate
 * polymorphism is a day-one shape, not a retrofit. Test code uses
 * `FakeCursorRunner` from `@ship/cursor-runner/test/fake`.
 *
 * Why pure TS interfaces (no Zod schemas) for these types: `CursorRunInput`
 * and friends never cross a persistence or transport boundary — they're
 * constructed in `core` and consumed by the runner inside the same Node
 * process. The TS compiler is the only validator we need; adding Zod
 * would buy nothing and force an extra parse on every `run()`. The shapes
 * that DO get persisted (the workflow row, the cursor-run row) live in
 * `@ship/workflow` and ARE Zod-validated there.
 */

import type { McpServerConfig, SDKMessage } from "@cursor/sdk";
import type { ModelSelection } from "@ship/workflow";

/**
 * The input required to start a single Cursor run.
 *
 * Constructed by the caller (typically `core`) per workflow run. The runner
 * does not mutate or persist this object; it reads what it needs and hands
 * the values off to the SDK.
 *
 * Fields:
 * - `cwd`         — absolute path of the workspace the agent should run
 *                   inside. Caller is responsible for setting this up; Ship
 *                   does not create or destroy workspaces (per spec.md
 *                   § ED-3).
 * - `prompt`      — the rendered implementation prompt `core` built from
 *                   the task doc + template. Verbatim; the runner does not
 *                   transform it.
 * - `model`       — model + parameter grid. Required at the runner
 *                   boundary; `core` resolves the default from config
 *                   before calling.
 * - `mcpServers`  — optional MCP servers to wire into the agent at create
 *                   time. Pass-through to `Agent.create({ mcpServers })`.
 * - `agentName`   — optional human-readable label for `Agent.list`
 *                   filtering. Conventionally `ship/<workflowRunId>` per
 *                   spec.md § ED-7.
 * - `signal`      — optional `AbortSignal`; aborting it cancels the SDK
 *                   run via `run.cancel()`. Composes with timers and
 *                   process-level SIGINT wiring in `core`.
 * - `onEvent`     — called once per `SDKMessage` emitted by the SDK
 *                   stream, in stream order. **Fire-and-forget; the
 *                   runner does NOT await the return value.** The
 *                   signature accepts `void | Promise<void>` so async
 *                   consumers typecheck cleanly, but the runner
 *                   attaches a no-op `.catch` to any returned Promise
 *                   without awaiting — both sync throws and async
 *                   rejections are silently swallowed (ED-4). Consumers
 *                   that need visibility queue work themselves with
 *                   their own error handling.
 */
export interface CursorRunInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: ModelSelection;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly agentName?: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: SDKMessage) => void | Promise<void>;
}

/**
 * The handle a `CursorRunner.run()` resolves to once the SDK has accepted
 * the prompt and started a run.
 *
 * `run()` itself returns once `Agent.create` + `agent.send` complete (so
 * the SDK has minted real ids and the stream is ready to iterate). After
 * that, `result` is the long-lived promise consumers `await` for the
 * terminal status.
 *
 * Fields:
 * - `agentId`  — SDK agent id (e.g. `agent-<uuid>` for local;
 *                `bc-<uuid>` for cloud per the SDK's runtime-prefix
 *                convention).
 * - `runId`    — SDK run id (e.g. `run-<uuid>`).
 * - `result`   — resolves to a `CursorRunResult` once the SDK reports a
 *                terminal status (succeeded/failed/cancelled). Does NOT
 *                reject for SDK-reported failures — those are surfaced
 *                via `result.status === "failed"` per the error-policy
 *                split in the design doc. Rejection is reserved for
 *                pre-run failures (e.g. `Agent.create` throwing) wrapped
 *                in `CursorRunFailedError`.
 * - `cancel`   — idempotent; a second call (or a call after natural
 *                termination) is a no-op enforced runner-side. Returns
 *                once the SDK acknowledges the cancel; `result` resolves
 *                shortly after with `status: "cancelled"`.
 */
export interface CursorRunHandle {
  readonly agentId: string;
  readonly runId: string;
  readonly result: Promise<CursorRunResult>;
  readonly cancel: () => Promise<void>;
}

/**
 * The terminal-state shape `handle.result` resolves to.
 *
 * Substrate-agnostic by construction: `branches` is always an array
 * (empty for local runs in V1; populated for cloud in V2). Local-only
 * impls will populate it as `[]`; cloud impls will surface
 * `RunResult.git.branches` here.
 *
 * Fields:
 * - `status`        — Ship's vocabulary, NOT the SDK's. The runner maps
 *                     `RunResult.status: "finished"` → `"succeeded"`,
 *                     `"error"` → `"failed"`, `"cancelled"` → `"cancelled"`.
 *                     See ED-3 for the why.
 * - `summary`       — `RunResult.result` verbatim — the final assistant
 *                     text. Per Spike § Surprises, this is exposed
 *                     directly on the SDK result; no event-scan parse is
 *                     needed. Optional only because the SDK type marks
 *                     it optional; in practice every successful run
 *                     populates it.
 * - `durationMs`    — `RunResult.durationMs ?? 0`. `0` is valid for
 *                     instant errors.
 * - `model`         — may be absent on resume per the SDK gotcha
 *                     documented in `cursor-sdk-typescript.md`. V1
 *                     doesn't resume, so this is always populated for
 *                     `LocalCursorRunner` outputs; the field is here for
 *                     V2 forward-compat.
 * - `branches`      — `RunResult.git?.branches ?? []`. Always `[]` for
 *                     local; cloud (V2) populates with branch + PR refs.
 * - `errorMessage`  — populated when `status === "failed"`; carries
 *                     whatever the SDK gave us in `result` for the
 *                     `"error"` terminal status.
 */
export interface CursorRunResult {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly summary?: string;
  readonly durationMs: number;
  readonly model?: ModelSelection;
  readonly branches: readonly {
    readonly repoUrl: string;
    readonly branch?: string;
    readonly prUrl?: string;
  }[];
  readonly errorMessage?: string;
}

/**
 * The contract `core` codes against. One method.
 *
 * Implementations:
 * - `LocalCursorRunner`  (Phase 5b)        — invokes `@cursor/sdk`'s
 *                                            `Agent.create({ local })`.
 * - `FakeCursorRunner`   (this phase, 5a)  — scriptable; no SDK calls.
 * - `CloudCursorRunner`  (V2)              — invokes
 *                                            `Agent.create({ cloud })`.
 *
 * Each implementation is a separate class; the substrate is NOT a
 * discriminator field on `CursorRunInput`. Per the design doc's
 * tradeoffs, polymorphism beats a runtime string here — cloud will need
 * different state (env vars, repos, autoCreatePR) than local, and folding
 * both behind one input type would force union handling at every call
 * site.
 */
export interface CursorRunner {
  run(input: CursorRunInput): Promise<CursorRunHandle>;
}

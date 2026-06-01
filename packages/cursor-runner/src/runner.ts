/**
 * `CursorRunner` — substrate-agnostic interface every consumer of the
 * Cursor SDK in Ship codes against. The package owns the SDK seam (per
 * ED-2 in `phases/05-cursor-runner.md`); other packages reach SDK
 * types via this file's re-exports.
 */

import type { AgentDefinition, McpServerConfig, SDKMessage } from "@cursor/sdk";
import type { ArtifactRef, ModelSelection } from "@ship/workflow";

/** Input required to start a single Cursor run. Constructed by `core` per workflow run. */
export interface CursorRunInput {
  /** Absolute path of the workspace the agent should run inside. */
  readonly cwd: string;
  /** Rendered implementation prompt; the runner does not transform it. */
  readonly prompt: string;
  /** Model + parameter grid. Required at the runner boundary. */
  readonly model: ModelSelection;
  /** Optional MCP servers wired into the agent at create time. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /**
   * Optional inline subagent definitions; passed through to `Agent.create`.
   * Same-named keys override file-based `.cursor/agents/*.md` (SDK precedence).
   */
  readonly agents?: Record<string, AgentDefinition>;
  /** Human-readable label for `Agent.list` filtering (conventionally `ship/<workflowRunId>`). */
  readonly agentName?: string;
  /** Aborting this signal cancels the SDK run via `run.cancel()`. */
  readonly signal?: AbortSignal;
  /**
   * Called once per `SDKMessage` in stream order. Fire-and-forget — the
   * runner doesn't await the return; both sync throws and async
   * rejections are silently swallowed (ED-4). Consumers that need
   * visibility queue work themselves.
   */
  readonly onEvent: (event: SDKMessage) => void | Promise<void>;

  /** Runtime selector. Defaults to "local" when omitted. */
  readonly runtime?: "local" | "cloud";

  /** Cloud-specific config. Required when runtime === "cloud"; ignored otherwise. */
  readonly cloud?: CloudRunSpec;

  /** Ship policy cap — used when folding SDK terminal errors into `errorMessage`. */
  readonly maxRunDurationMs?: number;
}

/** Input required to re-attach to an in-flight Cursor run (cloud resume). */
export interface CursorRunAttachInput {
  readonly agentId: string;
  readonly runId: string;
  /** Re-passed because the SDK doesn't carry these across `Agent.resume`. */
  readonly model: ModelSelection;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly agents?: Record<string, AgentDefinition>;
  /**
   * Required when attaching against a `CloudCursorRunner` (cloud runtime). The
   * `LocalCursorRunner.attach` path throws `LocalResumeNotSupportedError`
   * unconditionally and never reads this field, so leaving the type
   * structurally optional avoids forcing the local caller to pass a value
   * that's about to be ignored. `CloudCursorRunner.attach` throws
   * `MissingCloudSpecError` if it's undefined at the cloud entry point.
   */
  readonly cloud?: CloudRunSpec;
  readonly onEvent: (event: SDKMessage) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface CloudRunSpec {
  /**
   * GitHub repo the cloud agent operates against. Exactly one entry this
   * phase — multi-repo runs are out of scope.
   */
  readonly repos: readonly [
    { readonly url: string; readonly startingRef?: string; readonly prUrl?: string },
  ];
  /**
   * Push to existing branch instead of creating a new one. Default: false.
   * **Experimental** — the field passes through to the SDK but the
   * workflowRun-as-one-new-branch shape isn't designed for it.
   */
  readonly workOnCurrentBranch?: boolean;
  /**
   * Auto-open a PR when the run finishes. Optional at the type level;
   * `CloudCursorRunner` defaults to `true` when omitted (see
   * `cloud-runner.ts`'s `spec.autoCreatePR ?? true`). Pass `false`
   * explicitly to suppress cursor cloud's PR creation.
   */
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

/**
 * Handle returned once `Agent.create` + `agent.send` resolve. `result`
 * resolves on terminal status; `cancel` is idempotent.
 */
export interface CursorRunHandle {
  /** SDK agent id (`agent-<uuid>` for local; `bc-<uuid>` for cloud). */
  readonly agentId: string;
  /** SDK run id (`run-<uuid>`). */
  readonly runId: string;
  /**
   * Resolves on terminal status. Does NOT reject for SDK-reported
   * failures — those surface as `result.status === "failed"`.
   * Rejection is reserved for pre-run failures (`Agent.create` /
   * `agent.send` throw) wrapped in `CursorRunFailedError`.
   */
  readonly result: Promise<CursorRunResult>;
  /** Idempotent: cancel-after-terminal and concurrent calls are no-ops. */
  readonly cancel: () => Promise<void>;
}

/**
 * Terminal-state shape `handle.result` resolves to. Status is Ship's
 * vocabulary ("succeeded"/"failed"/"cancelled"), mapped from
 * `RunResult.status` per ED-3.
 */
export interface CursorRunResult {
  readonly status: "succeeded" | "failed" | "cancelled";
  /** `RunResult.result` verbatim — the final assistant text. */
  readonly summary?: string;
  /** `RunResult.durationMs ?? 0`. */
  readonly durationMs: number;
  readonly model?: ModelSelection;
  /** Empty for local runs; populated by cloud (V2). */
  readonly branches: readonly {
    readonly repoUrl: string;
    readonly branch?: string;
    readonly prUrl?: string;
  }[];
  /** Cloud-only divergence signals (omitted when empty). */
  readonly warnings?: readonly string[];
  /**
   * Cloud terminal manifest (refs only). Captured at terminal via
   * `listArtifacts()`; absent for local runs and when listing failed
   * with no entries.
   */
  readonly artifacts?: readonly ArtifactRef[];
  /** Populated when `status === "failed"`. */
  readonly errorMessage?: string;
  /** Raw SDK `RunResult.status` or last streamed `status` event (e.g. `error`, `ERROR`). */
  readonly sdkTerminalStatus?: string;
}

/**
 * The contract `core` codes against. V1 ships `LocalCursorRunner`;
 * tests use `FakeCursorRunner`; cloud (V2) is a separate class behind
 * the same interface.
 */
export interface CursorRunner {
  run(input: CursorRunInput): Promise<CursorRunHandle>;
  attach(input: CursorRunAttachInput): Promise<CursorRunHandle>;
  /**
   * Fetches artifact bytes from a cloud agent by id. Implemented on
   * {@link CloudCursorRunner} (and `FakeCursorRunner` for artifact tests);
   * `LocalCursorRunner` omits this method.
   */
  downloadArtifact?(agentId: string, path: string): Promise<Buffer>;
}

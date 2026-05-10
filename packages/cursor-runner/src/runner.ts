/**
 * `CursorRunner` — substrate-agnostic interface every consumer of the
 * Cursor SDK in Ship codes against. The package owns the SDK seam (per
 * ED-2 in `phases/05-cursor-runner.md`); other packages reach SDK
 * types via this file's re-exports.
 */

import type { McpServerConfig, SDKMessage } from "@cursor/sdk";
import type { ModelSelection } from "@ship/workflow";

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
  /** Populated when `status === "failed"`. */
  readonly errorMessage?: string;
}

/**
 * The contract `core` codes against. V1 ships `LocalCursorRunner`;
 * tests use `FakeCursorRunner`; cloud (V2) is a separate class behind
 * the same interface.
 */
export interface CursorRunner {
  run(input: CursorRunInput): Promise<CursorRunHandle>;
}

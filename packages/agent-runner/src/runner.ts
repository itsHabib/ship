/**
 * `AgentRunner` — provider-neutral interface every consumer codes against.
 * Concrete runners (`LocalCursorRunner`, future Claude runner) implement this.
 */

import type { Logger } from "@ship/logger";
import type { ArtifactRef, FailureCategory, ModelSelection } from "@ship/workflow";

import type { AgentDefinition, McpServerConfig } from "./agent-config.js";
import type { AgentEvent } from "./event-projection.js";
import type { SdkCauseSummary } from "./sdk-cause.js";

/** Input required to start a single agent run. Constructed by `core` per workflow run. */
export interface AgentRunInput {
  /** Absolute path of the workspace the agent should run inside. */
  readonly cwd: string;
  /** Rendered implementation prompt; the runner does not transform it. */
  readonly prompt: string;
  /** Model + parameter grid. Required at the runner boundary. */
  readonly model: ModelSelection;
  /** Optional MCP servers wired into the agent at create time. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /**
   * Optional inline subagent definitions; passed through to the provider.
   * Same-named keys override file-based agent definitions where supported.
   */
  readonly agents?: Record<string, AgentDefinition>;
  /** Human-readable label for agent listing (conventionally `ship/<workflowRunId>`). */
  readonly agentName?: string;
  /** Aborting this signal cancels the run. */
  readonly signal?: AbortSignal;
  /**
   * Called once per streamed event in order. Fire-and-forget — the runner
   * doesn't await the return; both sync throws and async rejections are
   * silently swallowed. Consumers that need visibility queue work themselves.
   */
  readonly onEvent: (event: AgentEvent) => void | Promise<void>;

  /** Runtime selector. Defaults to "local" when omitted. */
  readonly runtime?: "local" | "cloud" | "rooms";

  /** Cloud-specific config. Required when runtime === "cloud"; ignored otherwise. */
  readonly cloud?: CloudRunSpec;

  /** Rooms-specific config. Required when runtime === "rooms"; ignored otherwise. */
  readonly room?: RoomRunSpec;

  /** Ship policy cap — used when folding terminal errors into `errorMessage`. */
  readonly maxRunDurationMs?: number;
  /** Run-scoped structured logger; bound by `core` via `log.child(...)`. */
  readonly log?: Logger;
}

/** Input required to re-attach to an in-flight run (cloud resume). */
export interface AgentRunAttachInput {
  readonly agentId: string;
  readonly runId: string;
  /** Re-passed because resume paths may not carry model across attach. */
  readonly model: ModelSelection;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly agents?: Record<string, AgentDefinition>;
  /**
   * Required when attaching against a cloud runner. Local attach paths throw
   * unconditionally and never read this field.
   */
  readonly cloud?: CloudRunSpec;
  readonly onEvent: (event: AgentEvent) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
}

/**
 * Input for a one-shot, non-streaming terminal-state read of a cloud run
 * (`refreshRun`). Unlike attach, there is no event stream, no `onEvent`, and
 * no `signal` — the caller wants a single point-in-time answer, not a live
 * re-attach. Used by the driver tick, which runs in a short-lived CLI process
 * that must not hold sockets / pumps / cap timers open past its poll window.
 */
export interface AgentRunRefreshInput {
  readonly agentId: string;
  readonly runId: string;
  readonly log?: Logger;
}

export interface CloudRunSpec {
  readonly repos: readonly [
    {
      readonly url: string;
      readonly startingRef?: string;
      readonly prUrl?: string;
      /**
       * Branch the agent must push + open a PR from. Required (schema-enforced)
       * for `claude × cloud` — Managed Agents names no branch, so Ship prescribes
       * one and reconstructs the PR from it. Cursor cloud ignores it (its backend
       * names the branch).
       */
      readonly prBranch?: string;
    },
  ];
  readonly workOnCurrentBranch?: boolean;
  readonly autoCreatePR?: boolean;
  readonly skipReviewerRequest?: boolean;
  readonly envVars?: Record<string, string>;
  readonly env?: { readonly type: "cloud" | "pool" | "machine"; readonly name?: string };
}

export interface RoomRunSpec {
  readonly repos: readonly [{ readonly url: string; readonly startingRef?: string }];
  readonly image?: string;
  readonly pushBranch?: string;
}

/** Server-stamped liveness snapshot fed by the runner's provider-origin event stream. */
export interface AgentRunLiveness {
  readonly createdAtMs?: number;
  readonly lastEventAtMs?: number;
}

/** Server-stamped fields returned by an id-addressed run probe. */
export interface AgentRunProbeResult {
  readonly status?: string;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}

export interface AgentRunProbeArgs {
  readonly agentId: string;
  readonly runId: string;
}

/** Handle returned once a run starts. `result` resolves on terminal status; `cancel` is idempotent. */
export interface AgentRunHandle {
  readonly agentId: string;
  readonly runId: string;
  /**
   * Resolves on terminal status. Does NOT reject for provider-reported failures —
   * those surface as `result.status === "failed"`. Rejection is reserved for
   * pre-run failures wrapped in `AgentRunFailedError`.
   */
  readonly result: Promise<AgentRunResult>;
  readonly cancel: () => Promise<void>;
  /**
   * Sync, I/O-free liveness snapshot from provider-origin stream events.
   * Omitted on local and rooms runners.
   */
  readonly liveness?: () => AgentRunLiveness;
}

/** Per-run token usage lifted from provider terminal messages. */
export interface AgentRunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** Terminal-state shape `handle.result` resolves to. */
export interface AgentRunResult {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly summary?: string;
  readonly durationMs: number;
  readonly model?: ModelSelection;
  readonly branches: readonly {
    readonly repoUrl: string;
    readonly branch?: string;
    readonly prUrl?: string;
  }[];
  readonly warnings?: readonly string[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly errorMessage?: string;
  /** Raw provider terminal status (e.g. cursor `error`, `ERROR`, `expired`). */
  readonly sdkTerminalStatus?: string;
  /** Bounded event window for failure classification (runner → core handoff). */
  readonly classificationEvents?: readonly AgentEvent[];
  readonly failureCategory?: FailureCategory;
  readonly failureDetail?: string;
  /**
   * Bounded, redacted SDK cause fields (status/code/requestId/…) extracted
   * at the runner catch site. Finalize folds these into `errorMessage`.
   */
  readonly sdkCause?: SdkCauseSummary;
  /** Provider-reported token usage (claude/codex only today). */
  readonly usage?: AgentRunUsage;
  /** Provider-reported USD cost when exposed (claude only today). */
  readonly costUsd?: number;
}

/** The contract `core` codes against. */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunHandle>;
  attach(input: AgentRunAttachInput): Promise<AgentRunHandle>;
  downloadArtifact?(agentId: string, path: string): Promise<Buffer>;
  /**
   * Bounded async probe of a run by id before a handle exists (attach path).
   * Omitted on local and rooms runners.
   */
  probeRun?(args: AgentRunProbeArgs): Promise<AgentRunProbeResult | undefined>;
  /**
   * One-shot, non-streaming read of a cloud run's current terminal state.
   * Resolves the terminal `AgentRunResult` when the run has finished / errored
   * / been cancelled, or `undefined` when it is still running (or the read was
   * transiently unreachable — the caller leaves the row for a later refresh).
   * Rejects only for a definitively-gone run (`AgentNotFoundError`).
   *
   * Distinct from `attach`: no event stream, no heartbeat pump, no
   * duration-cap timer — nothing that outlives the single read. Omitted on
   * local and rooms runners (only cloud runs orphan across a process kill).
   */
  refreshRun?(input: AgentRunRefreshInput): Promise<AgentRunResult | undefined>;
}

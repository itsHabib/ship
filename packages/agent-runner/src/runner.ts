/**
 * `AgentRunner` — provider-neutral interface every consumer codes against.
 * Concrete runners (`LocalCursorRunner`, future Claude runner) implement this.
 */

import type { Logger } from "@ship/logger";
import type { ArtifactRef, FailureCategory, ModelSelection } from "@ship/workflow";

import type { AgentDefinition, McpServerConfig } from "./agent-config.js";
import type { AgentEvent } from "./event-projection.js";

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
}

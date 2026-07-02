/**
 * `@ship/cursor-runner` type surface — re-exports provider-neutral types
 * from `@ship/agent-runner`. SDK-specific runners implement `AgentRunner`.
 */

export type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
  CloudRunSpec,
  RoomRunSpec,
  AgentRunLiveness,
  AgentRunProbeArgs,
  AgentRunProbeResult,
} from "@ship/agent-runner";

export type { AgentDefinition, McpServerConfig } from "@ship/agent-runner";

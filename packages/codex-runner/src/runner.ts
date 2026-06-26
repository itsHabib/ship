/**
 * Neutral runner types — re-exported from `@ship/agent-runner` so consumers
 * import from `@ship/codex-runner` without reaching into the seam package.
 */

export type {
  AgentDefinition,
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
  McpServerConfig,
} from "@ship/agent-runner";

/**
 * `@ship/claude-runner` — public barrel. Other packages reach SDK types
 * via the re-exports below; the import-isolation test enforces that no
 * other package names `@anthropic-ai/claude-agent-sdk` directly.
 */

export {
  buildFailureDetail,
  classifyFailure,
  formatClassifiedErrorMessage,
} from "./classify-failure.js";
export type {
  ClaudeBuildFailureDetailInput,
  ClaudeClassifyFailureInput,
} from "./classify-failure.js";

export type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
} from "./runner.js";

export type { AgentDefinition, McpServerConfig } from "@ship/agent-runner";

export { LocalClaudeRunner } from "./local-runner.js";

export {
  AgentRunFailedError,
  MissingApiKeyError,
  OperationNotSupportedError,
  UnsupportedPlatformError,
  WrongRunnerError,
} from "./errors.js";

export { claudeEventProjection } from "./claude-event-projection.js";

export type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

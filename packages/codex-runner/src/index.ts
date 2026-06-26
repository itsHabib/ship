/**
 * `@ship/codex-runner` — public barrel. Other packages reach SDK types
 * via the re-exports below; the import-isolation test enforces that no
 * other package names `@openai/codex-sdk` or `@openai/codex` directly.
 */

export {
  buildFailureDetail,
  classifyFailure,
  formatClassifiedErrorMessage,
} from "./classify-failure.js";
export type {
  CodexBuildFailureDetailInput,
  CodexClassifyFailureInput,
} from "./classify-failure.js";

export type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
} from "./runner.js";

export type { AgentDefinition, McpServerConfig } from "@ship/agent-runner";

export { CodexRunner } from "./local-runner.js";

export {
  AgentRunFailedError,
  MissingApiKeyError,
  OperationNotSupportedError,
  UnsupportedPlatformError,
  WrongRunnerError,
} from "./errors.js";

export { codexEventProjection } from "./codex-event-projection.js";

export type { ThreadEvent } from "@openai/codex-sdk";

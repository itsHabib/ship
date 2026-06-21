/**
 * `@ship/agent-runner` — provider-neutral runner mechanism.
 */

export type { AgentDefinition, McpServerConfig } from "./agent-config.js";

export {
  buildFailureDetail,
  classifyFailure,
  formatClassifiedErrorMessage,
} from "./classify-failure.js";
export type { BuildFailureDetailInput, ClassifyFailureInput } from "./classify-failure.js";

export { attachInputAsRunInput } from "./attach-input.js";

export type { AgentEvent, EventProjection, ToolCallStatus } from "./event-projection.js";

export {
  formatRunningToolAge,
  formatWallDuration,
  MAX_CLASSIFICATION_EVENTS,
  stringifyToolCallResult,
  summarizeToolCall,
} from "./formatters.js";

export { buildSdkRunHandle, createSdkRunHandleState } from "./handle-state.js";
export type { SdkRunHandleCallbacks, SdkRunHandleState } from "./handle-state.js";

export {
  lastEventTimestamp,
  lastFailedToolCallDetail,
  lastRunningToolCall,
  lastTerminalStatus,
  runningToolDetail,
} from "./projection-helpers.js";
export type { RunningToolCallView } from "./projection-helpers.js";

export type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
  CloudRunSpec,
  RoomRunSpec,
} from "./runner.js";

export {
  AgentNotFoundError,
  AgentRunFailedError,
  agentRunFailedError,
  MissingApiKeyError,
} from "./errors.js";

export type { ArtifactRef, FailureCategory, ModelSelection } from "@ship/workflow";

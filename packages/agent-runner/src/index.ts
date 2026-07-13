/**
 * `@ship/agent-runner` — provider-neutral runner mechanism.
 */

export type { AgentDefinition, McpServerConfig } from "./agent-config.js";

export { captureListedArtifacts, LIST_ARTIFACTS_TIMEOUT_MS } from "./artifacts-capture.js";

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
  AgentRunLiveness,
  AgentRunProbeArgs,
  AgentRunProbeResult,
  AgentRunner,
  AgentRunRefreshInput,
  AgentRunResult,
  AgentRunUsage,
  CloudRunSpec,
  RoomRunSpec,
} from "./runner.js";

export {
  AgentNotFoundError,
  AgentRunFailedError,
  agentRunFailedError,
  MissingApiKeyError,
} from "./errors.js";
export type { AgentRunFailedErrorOptions } from "./errors.js";

export {
  causeSummaryFromThrown,
  foldSdkCauseIntoDetail,
  formatSdkCauseSuffix,
  MAX_SDK_CAUSE_DETAIL_CHARS,
} from "./sdk-cause.js";
export type { SdkCauseSummary } from "./sdk-cause.js";

export type { ArtifactRef, FailureCategory, ModelSelection } from "@ship/workflow";

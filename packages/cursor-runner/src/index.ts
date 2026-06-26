/**
 * `@ship/cursor-runner` — public barrel. Other packages reach SDK types
 * via the re-exports below; ED-2's import-isolation test enforces that no
 * other package names `@cursor/sdk` directly.
 */

export {
  buildFailureDetail,
  classifyFailure,
  formatClassifiedErrorMessage,
} from "./classify-failure.js";
export type {
  CursorBuildFailureDetailInput,
  CursorClassifyFailureInput,
} from "./classify-failure.js";

export type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
  CloudRunSpec,
  RoomRunSpec,
} from "./runner.js";

export type { AgentDefinition, McpServerConfig } from "@ship/agent-runner";

export { CloudCursorRunner } from "./cloud-runner.js";
export { LIST_ARTIFACTS_TIMEOUT_MS } from "./artifacts-capture.js";

export { LocalCursorRunner } from "./local-runner.js";

export { RoomCursorRunner } from "./room-runner.js";
export type {
  RoomCursorRunnerOptions,
  RoomsChild,
  RoomsSpawn,
  RoomsSpawnOptions,
} from "./room-runner.js";

export {
  CursorAgentNotFoundError,
  CursorCloudIntegrationError,
  InvalidCloudReposError,
  InvalidRoomReposError,
  LocalResumeNotSupportedError,
  MissingApiKeyError,
  MissingCloudSpecError,
  MissingRoomImageError,
  MissingRoomSpecError,
  RoomArtifactError,
  RoomResumeNotSupportedError,
  RoomSchemaVersionError,
  WrongRunnerError,
} from "./errors.js";
export { AgentRunFailedError } from "./errors.js";

export type { ArtifactRef } from "@ship/workflow";

export type { SDKMessage } from "@cursor/sdk";

export { cursorEventProjection } from "./cursor-event-projection.js";

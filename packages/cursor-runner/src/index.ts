/**
 * `@ship/cursor-runner` — public barrel. Other packages reach SDK
 * types via the re-exports below; ED-2's import-isolation test
 * (`test/sdk-import-isolation.test.ts`) enforces that no other package
 * names `@cursor/sdk` directly. `FakeCursorRunner` is exposed under
 * the `./test/fake` subpath, not this barrel.
 */

// --- runner.ts ---
export type {
  CloudRunSpec,
  CursorRunAttachInput,
  CursorRunHandle,
  CursorRunInput,
  CursorRunner,
  CursorRunResult,
  RoomRunSpec,
} from "./runner.js";

export type { ArtifactRef } from "@ship/workflow";

// --- cloud-runner.ts ---
export { CloudCursorRunner } from "./cloud-runner.js";
export { LIST_ARTIFACTS_TIMEOUT_MS } from "./artifacts-capture.js";

// --- local-runner.ts ---
export { LocalCursorRunner } from "./local-runner.js";

// --- room-runner.ts ---
export { RoomCursorRunner } from "./room-runner.js";
export type {
  RoomCursorRunnerOptions,
  RoomsChild,
  RoomsSpawn,
  RoomsSpawnOptions,
} from "./room-runner.js";

// --- errors.ts ---
export {
  CursorAgentNotFoundError,
  CursorCloudIntegrationError,
  CursorRunFailedError,
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

// --- @cursor/sdk re-exports ---
export type { AgentDefinition, McpServerConfig, SDKMessage } from "@cursor/sdk";

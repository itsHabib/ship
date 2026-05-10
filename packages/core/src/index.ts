/** `@ship/core` — public barrel. */

// --- service ---
export type { ShipService, ShipServiceConfig, ShipServiceDeps } from "./service.js";
export { createShipService } from "./service.js";

// --- errors ---
export {
  ArtifactWriteFailedError,
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  WorkdirNotFoundError,
} from "./errors.js";

// --- fs ---
export type { FileStat, MemoryShipFs, ShipFs } from "./fs/index.js";
export { createMemoryShipFs, createNodeShipFs } from "./fs/index.js";

// --- artifacts ---
export type { EventWriter } from "./artifacts/ndjson.js";
export { createNdjsonEventWriter } from "./artifacts/ndjson.js";

export type { ArtifactName, RunArtifactPaths } from "./artifacts/paths.js";
export {
  ARTIFACT_FILES,
  resolveRunArtifactsDir,
  resolveRunArtifactPaths,
} from "./artifacts/paths.js";

export type { RenderImplementationPromptInput } from "./artifacts/prompt-template.js";
export { renderImplementationPrompt } from "./artifacts/prompt-template.js";

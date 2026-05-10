/**
 * `@ship/core` — public barrel. 6a publishes the artifact helpers + the
 * `ShipFs` interface; 6b adds `ShipService` + `createShipService`.
 */

// --- fs ---
export type { FileStat, ShipFs } from "./fs/index.js";
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

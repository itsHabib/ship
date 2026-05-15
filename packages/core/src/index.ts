/** `@ship/core` — public barrel. */

// --- service ---
export type { ShipService, ShipServiceConfig, ShipServiceDeps } from "./service.js";
export { createShipService } from "./service.js";

// --- default production wiring (consumed by cli + mcp-server) ---
export type { DefaultShipServiceOpts, ShipServiceFactory } from "./default-wiring.js";
export { createDefaultShipService } from "./default-wiring.js";

// --- re-exports of MCP boundary types so consumers (cli, mcp-server) ---
// don't need a direct `@ship/mcp` dep just to type ShipService's surface.
export type {
  ListWorkflowRunsInput,
  ShipArtifacts,
  ShipInput,
  ShipOutput,
  ShipStartOutput,
} from "@ship/mcp";

// `ShipService.listRuns` consumes `ListRunsFilter` from `@ship/store`;
// re-exported here so consumers don't need a separate `@ship/store` dep
// just to type the filter argument.
export type { ListRunsFilter } from "@ship/store";

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

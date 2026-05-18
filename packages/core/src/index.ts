/** `@ship/core` — public barrel. */

// --- service ---
export type {
  ActiveRun,
  ActiveRunsRegistry,
  ShipService,
  ShipServiceConfig,
  ShipServiceDeps,
} from "./service.js";
export { createShipService } from "./service.js";

// --- open_pr service (V2 phase 02) ---
export type { OpenPrInput, OpenPrOutput, OpenPrService, OpenPrServiceDeps } from "./open-pr.js";
export { createOpenPrService } from "./open-pr.js";

// --- gh / git shell-out interfaces ---
export type { GhClient, GhPrRef } from "./gh.js";
export { createNodeGhClient } from "./gh.js";
export type { GitRemote } from "./git-remote.js";
export { createNodeGitRemote } from "./git-remote.js";

// --- default production wiring (consumed by cli + mcp-server) ---
export type {
  DefaultOpenPrServiceOpts,
  DefaultShipServiceOpts,
  OpenPrServiceFactory,
  ShipServiceFactory,
} from "./default-wiring.js";
export { createDefaultOpenPrService, createDefaultShipService } from "./default-wiring.js";

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
  BaseBranchUnresolvedError,
  BranchPushFailedError,
  CloudRunnerNotConfiguredError,
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  EmptyBranchError,
  GhAuthError,
  GhCreatePrFailedError,
  ImplementPhaseNotSucceededError,
  OpenPrAbortedError,
  OriginHeadUnsetError,
  OriginRepoUnresolvedError,
  WorkdirNotFoundError,
  WorkdirNotGitError,
  WorkflowRunStillActiveError,
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

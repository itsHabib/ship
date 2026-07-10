/**
 * `@ship/driver` — work-driver manifest input contract + engine.
 *
 * Parses and validates `driver.md` YAML frontmatter, persists progress in
 * `@ship/store`, and runs the deterministic dispatch/poll loop.
 * See docs/features/driver-extraction/spec.md for the full design.
 */

export type {
  DriverManifest,
  EffortTier,
  ManifestBatch,
  ManifestStream,
  ManifestParseError,
  ModelTier,
  ParseManifestResult,
} from "./manifest.js";
export {
  driverManifestSchema,
  effortTierSchema,
  manifestBatchSchema,
  manifestStreamSchema,
  modelTierSchema,
  parseManifest,
} from "./manifest.js";

export { ImportManifestError, importManifest } from "./import.js";
export type { ImportManifestResult } from "./import.js";

export { renderDriverRun } from "./render.js";

export { mapTierToDispatch } from "./tier-map.js";

export {
  formatStreamTierDiagnostic,
  manifestBatchStatusToStore,
  manifestStatusToStore,
  resolveStreamTier,
  resolveStreamProvider,
  storeBatchStatusToManifest,
  storeStatusToManifest,
} from "./status-mapping.js";

export type { DriverGhPort, GhMergeCommit, GhMergeOpts, GhPullRequestView } from "./gh-port.js";
export { createExecGhPort } from "./gh-port.js";

export type { DriverShipPort } from "./ship-port.js";

export type {
  AddressOpts,
  CanonicalReviewer,
  CiCheckState,
  Decision,
  DriverRunRef,
  DriverStreamView,
  DriverTickResult,
  JudgmentRequest,
  LandOpts,
  MergeFacts,
  MergeVerdict,
  MergeVerdictEvidence,
  MergeVerdictInputs,
  MergeVerdictOutcome,
  ReviewerBallot,
  ReviewerBallotVerdict,
  RunOpts,
  TierDegrade,
  TierDispatchResult,
} from "./types.js";

export {
  assembleMergeVerdict,
  CANONICAL_REVIEWERS,
  REQUIRED_REVIEW_COORDINATOR_CYCLES,
} from "./merge-verdict.js";

export {
  AddressError,
  CancelError,
  DecideError,
  DriverRunNotFoundEngineError,
  PreconditionError,
  TickLiveError,
} from "./errors.js";
export type { AddressRefusalCode } from "./errors.js";

export { createDriverService } from "./service.js";
export type { CreateDriverServiceOpts, DriverService } from "./service.js";

export {
  address,
  isTickLive,
  resolveDocPath,
  resolveRepoRoot,
  resolveRunOpts,
  flipStreamToCloud,
} from "./engine.js";
export type { AddressDeps, CloudContinuation } from "./engine.js";

export {
  allStreams,
  batchHasPendingDispatchable,
  isBatchEligible,
  isBlockedOnMerges,
} from "./judgment.js";

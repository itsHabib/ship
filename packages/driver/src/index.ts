/**
 * `@ship/driver` — work-driver manifest input contract + engine.
 *
 * Parses and validates `driver.md` YAML frontmatter, persists progress in
 * `@ship/store`, and runs the deterministic dispatch/poll loop.
 * See docs/features/driver-extraction/spec.md for the full design.
 */

export type {
  DriverManifest,
  ManifestBatch,
  ManifestStream,
  ManifestParseError,
  ParseManifestResult,
} from "./manifest.js";
export {
  driverManifestSchema,
  manifestBatchSchema,
  manifestStreamSchema,
  parseManifest,
} from "./manifest.js";

export { ImportManifestError, importManifest } from "./import.js";
export type { ImportManifestResult } from "./import.js";

export { renderDriverRun } from "./render.js";

export {
  manifestBatchStatusToStore,
  manifestStatusToStore,
  storeBatchStatusToManifest,
  storeStatusToManifest,
} from "./status-mapping.js";

export type {
  DriverGhPort,
  GhMergeCommit,
  GhMergeOpts,
  GhPrMergeGateFacts,
  GhPullRequestView,
  GhReviewEntry,
} from "./gh-port.js";
export { createExecGhPort } from "./gh-port.js";

export type { DriverShipPort } from "./ship-port.js";

export type {
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
} from "./types.js";

export {
  assembleMergeVerdict,
  CANONICAL_REVIEWERS,
  REQUIRED_REVIEW_COORDINATOR_CYCLES,
} from "./merge-verdict.js";

export {
  assembleMergeVerdictFromGh,
  ciCheckStateFromReadiness,
  reviewerBallotsFromReviews,
} from "./merge-verdict-from-gh.js";

export {
  CancelError,
  DecideError,
  DriverRunNotFoundEngineError,
  PreconditionError,
  TickLiveError,
} from "./errors.js";

export { createDriverService } from "./service.js";
export type { CreateDriverServiceOpts, DriverService } from "./service.js";

export { isTickLive, resolveDocPath, resolveRepoRoot, resolveRunOpts } from "./engine.js";

export {
  allStreams,
  batchHasPendingDispatchable,
  isBatchEligible,
  isBlockedOnMerges,
} from "./judgment.js";

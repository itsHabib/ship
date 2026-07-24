/**
 * `@ship/store` public barrel. SQLite persistence behind a hand-written SQL
 * layer, hydrated through Zod schemas. Exposes `createStore`, the `Store`
 * interface, input shapes, and typed errors.
 */

export { createStore } from "./store.js";
export type { CreateStoreOptions, Store } from "./store.js";

export { isSqliteCorruptError } from "./db.js";

export type {
  CreateWorkflowRunInput,
  ListRunsFilter,
  WorkflowRunPruneRow,
} from "./workflow-runs.js";

export type { AppendPhaseInput, UpdatePhaseInput } from "./phases.js";

export type {
  RecordCursorRunInput,
  ResumableCloudCursorRun,
  UpdateCursorRunInput,
} from "./cursor-runs.js";

export type {
  DriverBatch,
  DriverBatchStatus,
  DriverRun,
  DriverRunStatus,
  DriverStream,
  DriverStreamStatus,
  FallbackChainTarget,
  FallbackLogRecord,
  StreamAttempt,
  TriageTier,
  TriageTierSource,
} from "./driver-schemas.js";

export type {
  ClaimTickInput,
  InsertDriverBatchInput,
  InsertDriverRunInput,
  InsertDriverStreamInput,
  ListDriverRunsFilter,
} from "./driver-runs.js";

export type { UpdateDriverBatchInput } from "./driver-batches.js";
export type { UpdateDriverStreamInput } from "./driver-streams.js";
export type { ConsumeReviewArtifactInput } from "./review-artifacts.js";

export type { Escalation } from "./escalation-schemas.js";
export type {
  EscalationOpenKey,
  InsertEscalationInput,
  ListEscalationsFilter,
} from "./escalations.js";

export {
  newDriverBatchId,
  newDriverRunId,
  newDriverStreamId,
  newEscalationId,
} from "./driver-ids.js";

export {
  CursorRunNotFoundError,
  DriverBatchNotFoundError,
  DriverRunNotFoundError,
  DriverStreamNotFoundError,
  EscalationNotFoundError,
  EscalationOpenRowExistsError,
  LOCAL_RUN_CONTENTION_HINT,
  LOCAL_RUNTIME_PARALLELISM_LIMIT,
  MigrationError,
  PhaseNotFoundError,
  ReviewArtifactAddressRacedError,
  ReviewArtifactDuplicateError,
  SchemaAheadError,
  SchemaSkewError,
  StoreContentionError,
  StoreIntegrityError,
  StoreSchemaError,
  WorkflowRunNotFoundError,
} from "./errors.js";

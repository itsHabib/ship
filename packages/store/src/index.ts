/**
 * `@ship/store` public barrel. SQLite persistence behind a hand-written SQL
 * layer, hydrated through Zod schemas. Exposes `createStore`, the `Store`
 * interface, input shapes, and typed errors.
 */

export { createStore } from "./store.js";
export type { CreateStoreOptions, Store } from "./store.js";

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
  StreamAttempt,
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

export { newDriverBatchId, newDriverRunId, newDriverStreamId } from "./driver-ids.js";
export { newMergeGrantId, newMergeGrantSatisfactionId } from "./merge-grant-ids.js";

export type {
  MergeGrantSatisfaction,
  RecordMergeGrantSatisfactionInput,
  RepoMergeGrant,
} from "./merge-grants.js";
export { normalizeMergeGrantRepo } from "./merge-grants.js";

export {
  CursorRunNotFoundError,
  DriverBatchNotFoundError,
  DriverRunNotFoundError,
  DriverStreamNotFoundError,
  LOCAL_RUN_CONTENTION_HINT,
  LOCAL_RUNTIME_PARALLELISM_LIMIT,
  MigrationError,
  PhaseNotFoundError,
  SchemaAheadError,
  SchemaSkewError,
  StoreContentionError,
  StoreSchemaError,
  WorkflowRunNotFoundError,
} from "./errors.js";

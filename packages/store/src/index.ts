/**
 * `@ship/store` public barrel. SQLite persistence behind a hand-written SQL
 * layer, hydrated through `@ship/workflow`'s Zod schemas. Exposes
 * `createStore`, the `Store` interface, input shapes, and typed errors.
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

export {
  CursorRunNotFoundError,
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

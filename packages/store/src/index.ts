/**
 * `@ship/store` public barrel. SQLite persistence behind a hand-written SQL
 * layer, hydrated through `@ship/workflow`'s Zod schemas. Exposes
 * `createStore`, the `Store` interface, input shapes, and typed errors.
 */

export { createStore } from "./store.js";
export type { CreateStoreOptions, Store } from "./store.js";

export type { CreateWorkflowRunInput, ListRunsFilter } from "./workflow-runs.js";

export type { AppendPhaseInput, UpdatePhaseInput } from "./phases.js";

export type {
  RecordCursorRunInput,
  ResumableCloudCursorRun,
  UpdateCursorRunInput,
} from "./cursor-runs.js";

export {
  CursorRunNotFoundError,
  MigrationError,
  PhaseNotFoundError,
  SchemaAheadError,
  SchemaSkewError,
  StoreSchemaError,
  WorkflowRunNotFoundError,
} from "./errors.js";

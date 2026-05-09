/**
 * `@ship/store` — public barrel export.
 *
 * The persistence package: SQLite (`better-sqlite3`) behind a hand-written
 * SQL layer, hydrated through `@ship/workflow`'s Zod schemas. Exposes
 * exactly one factory (`createStore`) and the typed inputs / errors
 * consumers need to work with it.
 *
 * What this package contains:
 * - `createStore({ dbPath, clock })` — opens the connection, applies
 *   PRAGMAs, runs migrations, returns a `Store` whose methods cover the
 *   V1 persistence surface (workflow runs, phases, cursor runs).
 * - `Store` interface and its input shapes (`CreateWorkflowRunInput`,
 *   `AppendPhaseInput`, `UpdatePhaseInput`, `RecordCursorRunInput`,
 *   `UpdateCursorRunInput`, `ListRunsFilter`).
 * - Typed error subclasses for the four documented failure modes
 *   (`WorkflowRunNotFoundError`, `PhaseNotFoundError`, `StoreSchemaError`,
 *   `MigrationError`).
 *
 * What this package does NOT contain:
 * - The artifact filesystem layout (prompt.md, events.ndjson, etc.) —
 *   that's `core`'s concern.
 * - `<UserConfigDir>` resolution — `core` resolves `dbPath` and passes
 *   it in (per § ED-7).
 * - The migration runner, the `Db` handle alias, the per-table ops —
 *   all internal.
 *
 * Stability promise (within V1): adding a `Store` method is fine;
 * removing or changing a method's signature is a breaking change that
 * updates `core` in the same commit. The migration set is append-only;
 * once a migration is on `main`, it never gets edited. New migrations
 * always get a higher number.
 */

// --- store.ts: factory + Store interface + input types ---
export { createStore } from "./store.js";
export type { CreateStoreOptions, Store } from "./store.js";

// --- workflow-runs.ts: input types ---
export type { CreateWorkflowRunInput, ListRunsFilter } from "./workflow-runs.js";

// --- phases.ts: input types ---
export type { AppendPhaseInput, UpdatePhaseInput } from "./phases.js";

// --- cursor-runs.ts: input types ---
export type { RecordCursorRunInput, UpdateCursorRunInput } from "./cursor-runs.js";

// --- errors.ts: typed error subclasses ---
export {
  CursorRunNotFoundError,
  MigrationError,
  PhaseNotFoundError,
  StoreSchemaError,
  WorkflowRunNotFoundError,
} from "./errors.js";

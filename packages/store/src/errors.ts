/**
 * Typed error subclasses for `@ship/store`.
 *
 * The store throws one of these for every **expected** failure mode, so
 * `core` can `instanceof`-discriminate without parsing message strings.
 * Internal-invariant violations ("a row vanished after I just inserted
 * it") are bugs in the store itself, not the caller's contract — those
 * surface as plain `Error` and never as one of these subclasses; if a
 * caller ever sees one, it's a `@ship/store` bug.
 *
 * Why these specifically (per phases/03-store.md § "Error policy"):
 * - `WorkflowRunNotFoundError` / `PhaseNotFoundError` /
 *   `CursorRunNotFoundError` separate the three "id doesn't resolve"
 *   cases so callers can produce different UX per kind. Read methods
 *   (`getRun`, `getCursorRun`, `listRuns`) return `null` / `[]`
 *   instead — `not-found` is only an error from a mutator's
 *   perspective.
 * - `StoreSchemaError` is the catch for hydration failures — JSON-blob
 *   corruption, column drift, missing required column. The Zod parse at
 *   the seam throws this with the offending field path in the message.
 * - `MigrationError` is the catch for SQL failures inside `runMigrations`
 *   so a failed migration can be told from a runtime query failure.
 *
 * `cause` is set on the wrapping errors (`StoreSchemaError`, `MigrationError`)
 * so the original `ZodError` / SQLite error survives in `error.cause` for
 * debugging.
 */

/**
 * Thrown when a `WorkflowRun` referenced by id does not exist.
 *
 * `getRun` and `listRuns` do NOT throw this — they return `null` / `[]` for
 * "not found." Mutators (`updateWorkflowRunStatus`, `cancelRun`, `appendPhase`,
 * `updatePhase`'s parent lookup) do, because mutating a non-existent row is
 * always a caller bug.
 */
export class WorkflowRunNotFoundError extends Error {
  /** Identifies the subclass at runtime without `instanceof`. */
  override readonly name = "WorkflowRunNotFoundError";
  /** The id the caller passed in; included so the message and the field stay in sync. */
  readonly workflowRunId: string;

  constructor(workflowRunId: string) {
    super(`workflow run not found: ${workflowRunId}`);
    this.workflowRunId = workflowRunId;
  }
}

/**
 * Thrown by `updatePhase` when the phase id does not resolve.
 *
 * Unlike `WorkflowRunNotFoundError`, "phase not found" can mean either a
 * stale id or a wrong-package bug; the message stays generic and the caller
 * decides.
 */
export class PhaseNotFoundError extends Error {
  /** Identifies the subclass at runtime without `instanceof`. */
  override readonly name = "PhaseNotFoundError";
  /** The id the caller passed in. */
  readonly phaseId: string;

  constructor(phaseId: string) {
    super(`phase not found: ${phaseId}`);
    this.phaseId = phaseId;
  }
}

/**
 * Thrown by `updateCursorRunStatus` when the cursor-run id does not
 * resolve. `getCursorRun` returns `null` for the same case (read methods
 * surface "not found" as a value, not an exception).
 */
export class CursorRunNotFoundError extends Error {
  /** Identifies the subclass at runtime without `instanceof`. */
  override readonly name = "CursorRunNotFoundError";
  /** The id the caller passed in. */
  readonly cursorRunId: string;

  constructor(cursorRunId: string) {
    super(`cursor run not found: ${cursorRunId}`);
    this.cursorRunId = cursorRunId;
  }
}

/**
 * Thrown when a row → domain hydration fails.
 *
 * Wraps either a `ZodError` (the parse at the seam in `getRun` / `listRuns`
 * / `getCursorRun` rejected the hydrated shape) or a `SyntaxError` (a JSON
 * blob column was malformed). The original error is preserved in `cause` for
 * stack-trace debugging; the message includes a short hint about which
 * column / table tripped the parse.
 *
 * In V1 this is a "drift detector" — a column that exists in SQL but isn't
 * declared in `@ship/workflow`'s schema (or vice versa) fails the Zod parse
 * here, before the bad shape leaks downstream.
 *
 * No custom constructor — the builtin `Error(message, { cause })` form is
 * exactly what we need; the subclass identity (`instanceof
 * StoreSchemaError`) plus the overridden `name` carry the discriminating
 * meaning. Callers throw with `new StoreSchemaError(msg, { cause: err })`.
 */
export class StoreSchemaError extends Error {
  /** Identifies the subclass at runtime without `instanceof`. */
  override readonly name = "StoreSchemaError";
}

/**
 * Thrown when `runMigrations` fails to apply a migration.
 *
 * Wraps the underlying SQLite error in `cause`. The message names the
 * migration filename so a CI failure points at the right SQL file without
 * grep.
 */
export class MigrationError extends Error {
  /** Identifies the subclass at runtime without `instanceof`. */
  override readonly name = "MigrationError";
  /** The migration filename (e.g. `"0001_init.sql"`) that failed. */
  readonly migrationName: string;

  constructor(migrationName: string, message: string, options?: { cause?: unknown }) {
    super(`migration ${migrationName} failed: ${message}`, options);
    this.migrationName = migrationName;
  }
}

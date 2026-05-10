/**
 * Typed error subclasses for `@ship/store`. Per phases/03-store.md § "Error
 * policy". The store throws one of these for every expected failure mode so
 * callers can `instanceof`-discriminate without parsing message strings.
 * Internal-invariant violations surface as plain `Error`.
 */

/**
 * Thrown when a `WorkflowRun` referenced by id does not exist. Read methods
 * (`getRun`, `listRuns`) return `null` / `[]` instead — `not-found` is only
 * an error from a mutator's perspective.
 */
export class WorkflowRunNotFoundError extends Error {
  override readonly name = "WorkflowRunNotFoundError";
  readonly workflowRunId: string;

  constructor(workflowRunId: string) {
    super(`workflow run not found: ${workflowRunId}`);
    this.workflowRunId = workflowRunId;
  }
}

/** Thrown by `updatePhase` when the phase id does not resolve. */
export class PhaseNotFoundError extends Error {
  override readonly name = "PhaseNotFoundError";
  readonly phaseId: string;

  constructor(phaseId: string) {
    super(`phase not found: ${phaseId}`);
    this.phaseId = phaseId;
  }
}

/**
 * Thrown by `updateCursorRunStatus` when the cursor-run id does not resolve.
 * `getCursorRun` returns `null` for the same case.
 */
export class CursorRunNotFoundError extends Error {
  override readonly name = "CursorRunNotFoundError";
  readonly cursorRunId: string;

  constructor(cursorRunId: string) {
    super(`cursor run not found: ${cursorRunId}`);
    this.cursorRunId = cursorRunId;
  }
}

/**
 * Thrown when a row → domain hydration fails. Wraps a `ZodError` (Zod parse
 * at the seam rejected the shape) or `SyntaxError` (malformed JSON column)
 * in `cause`. Serves as the drift detector between SQL and the domain
 * schemas.
 */
export class StoreSchemaError extends Error {
  override readonly name = "StoreSchemaError";
}

/**
 * Thrown when `runMigrations` fails to apply a migration. Wraps the
 * underlying SQLite error in `cause`; the message names the migration
 * filename.
 */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
  readonly migrationName: string;

  constructor(migrationName: string, message: string, options?: { cause?: unknown }) {
    super(`migration ${migrationName} failed: ${message}`, options);
    this.migrationName = migrationName;
  }
}

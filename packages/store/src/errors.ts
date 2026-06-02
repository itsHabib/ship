/**
 * Typed error subclasses for `@ship/store`. Per phases/03-store.md § "Error
 * policy". The store throws one of these for every expected failure mode so
 * callers can `instanceof`-discriminate without parsing message strings.
 * Internal-invariant violations surface as plain `Error`.
 */

import { LOCAL_RUN_CONTENTION_HINT } from "@ship/workflow";

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

/**
 * Thrown when `createStore` opens a DB whose applied migration count is
 * behind the migrations shipped with the running build. Distinct from
 * `MigrationError` (apply failure) — this is a post-migrate version check.
 */
export class SchemaSkewError extends Error {
  override readonly name = "SchemaSkewError";
  readonly dbMigrationCount: number;
  readonly codeMigrationCount: number;

  constructor(dbMigrationCount: number, codeMigrationCount: number) {
    super(
      `ship DB schema is behind the running code (DB at ${String(dbMigrationCount)}, code expects ${String(codeMigrationCount)}). Restart ship to apply pending migrations.`,
    );
    this.dbMigrationCount = dbMigrationCount;
    this.codeMigrationCount = codeMigrationCount;
  }
}

/**
 * Thrown when `createStore` opens a DB whose applied migrations are *ahead* of
 * the build (a downgrade: every shipped migration is applied, plus extras this
 * build doesn't ship). Distinct from `SchemaSkewError` (behind) so callers can
 * discriminate the two skew directions.
 */
export class SchemaAheadError extends Error {
  override readonly name = "SchemaAheadError";
  readonly dbMigrationCount: number;
  readonly codeMigrationCount: number;

  constructor(dbMigrationCount: number, codeMigrationCount: number) {
    super(
      `ship DB schema is ahead of the running code (DB at ${String(dbMigrationCount)}, code expects ${String(codeMigrationCount)}). Downgrade ship or migrate the DB forward.`,
    );
    this.dbMigrationCount = dbMigrationCount;
    this.codeMigrationCount = codeMigrationCount;
  }
}

// Re-exported from @ship/workflow so the hint string is shared with
// cursor-runner (which can't depend on @ship/store) without duplicating the
// literal, which would drift.
export { LOCAL_RUN_CONTENTION_HINT };

/** Supported concurrent local-runtime `ship` runs against one `state.db`. */
export const LOCAL_RUNTIME_PARALLELISM_LIMIT = 2;

/**
 * Thrown when a store operation hits `SQLITE_BUSY` / `database is locked` after
 * `busy_timeout` backoff. Distinct from transient internal retries — callers
 * should surface this message to operators instead of a raw SQLite string.
 */
export class StoreContentionError extends Error {
  override readonly name = "StoreContentionError";

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${LOCAL_RUN_CONTENTION_HINT} (ship store: ${detail}; safe limit: at most ${String(LOCAL_RUNTIME_PARALLELISM_LIMIT)} concurrent local runtime runs)`,
      { cause },
    );
  }
}

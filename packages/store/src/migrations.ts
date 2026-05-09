/**
 * Migration runner for `@ship/store`.
 *
 * Migrations live as numbered SQL files under `packages/store/migrations/`.
 * The runner:
 *   1. Creates the `_migrations` bookkeeping table if it doesn't exist.
 *   2. Reads the migrations directory in lexicographic order.
 *   3. For each file not already recorded in `_migrations.name`, opens a
 *      transaction, executes the file's SQL, inserts the bookkeeping row,
 *      commits.
 *   4. Returns silently once caught up.
 *
 * Atomicity (per phases/03-store.md § ED-2): each migration's SQL and its
 * `_migrations` INSERT happen in the SAME transaction. A failure anywhere
 * inside the migration rolls both back; a power loss between the two is
 * impossible because they're not two separate operations.
 *
 * Idempotency: re-running on an already-migrated DB is a no-op. A crashed
 * mid-migration is recovered by re-running on next boot — the `_migrations`
 * row never landed, so the file is retried from the top.
 *
 * The runner does not look at `down.sql` files (V1 has none). Rolling back
 * during dev is `rm <UserConfigDir>/ship/state.db*` per the task doc.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "./db.js";

import { MigrationError } from "./errors.js";

/**
 * Absolute path to the directory holding the SQL migration files.
 *
 * Resolved from `import.meta.url`, which at runtime points at this module's
 * source location (`packages/store/src/migrations.ts`). The migrations
 * directory is `../migrations/` relative to that. Because this package ships
 * `.ts` directly (`main: ./src/index.ts`, no build step), the path holds for
 * vitest, consumers importing the source, and any future bundler that
 * preserves the source layout.
 */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Filename suffix the runner will pick up. Other files in the dir are ignored. */
const MIGRATION_FILE_SUFFIX = ".sql";

/**
 * Optional dependencies for `runMigrations`.
 *
 * - `clock` — same injectable clock the rest of the store uses; the
 *             `_migrations.applied_at` column is set with it. Defaults to
 *             `() => new Date().toISOString()`.
 * - `migrationsDir` — override for tests that exercise a synthetic second
 *                     migration or a deliberately-broken one. Production
 *                     callers pass nothing.
 */
export interface RunMigrationsOptions {
  clock?: () => string;
  migrationsDir?: string;
}

/** Internal: one row out of the `_migrations` table. */
interface MigrationRow {
  name: string;
}

/**
 * Applies any pending migrations to `db` in lexicographic filename order.
 *
 * Throws `MigrationError` if a migration's SQL fails; the original SQLite
 * error is attached as `cause`. After throwing, the partial transaction has
 * been rolled back and the bookkeeping row has not been inserted, so the
 * next call retries the failed migration from the top.
 *
 * Synchronous; matches the rest of `@ship/store`.
 */
export function runMigrations(db: Db, opts: RunMigrationsOptions = {}): void {
  const clock = opts.clock ?? defaultClock;
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;

  ensureBookkeepingTable(db);

  const applied = new Set(
    db
      .prepare<[], MigrationRow>("SELECT name FROM _migrations")
      .all()
      .map((r) => r.name),
  );

  const pending = readdirSync(dir)
    .filter((f) => f.endsWith(MIGRATION_FILE_SUFFIX))
    .sort()
    .filter((f) => !applied.has(f));

  for (const filename of pending) {
    applyMigration(db, filename, readFileSync(join(dir, filename), "utf8"), clock());
  }
}

/**
 * Default clock used when `runMigrations` isn't given one. Kept here (rather
 * than imported from a shared module) so the migrations file has a single
 * surface to override in tests.
 */
function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * Creates the `_migrations` bookkeeping table if it doesn't already exist.
 *
 * Defined here, not in `0001_init.sql`, so the migration files stay focused
 * on application schema. Per phases/03-store.md § "Refinements vs raw
 * spec.md".
 */
function ensureBookkeepingTable(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
}

/**
 * Applies one migration inside a single transaction.
 *
 * The transaction wraps both `db.exec(sql)` and the `_migrations` INSERT, so
 * either both commit or neither does. SQLite errors are caught and re-thrown
 * as `MigrationError` with the underlying error attached as `cause`.
 */
function applyMigration(db: Db, filename: string, sql: string, appliedAt: string): void {
  const insert = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
  const txn = db.transaction(() => {
    db.exec(sql);
    insert.run(filename, appliedAt);
  });
  try {
    txn();
  } catch (err: unknown) {
    throw new MigrationError(
      filename,
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? { cause: err } : undefined,
    );
  }
}

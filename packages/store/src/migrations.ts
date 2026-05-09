/**
 * Migration runner for `@ship/store`.
 *
 * Migrations live as numbered SQL files under `packages/store/migrations/`.
 * The runner:
 *   1. Creates the `_migrations` bookkeeping table if it doesn't exist.
 *   2. Opens a single `BEGIN IMMEDIATE` transaction, then within it reads
 *      `_migrations` for the applied set, walks the migrations directory
 *      in lexicographic order, and for each pending file executes the
 *      SQL and inserts the bookkeeping row.
 *   3. Commits (or rolls back on any failure).
 *
 * Atomicity (per phases/03-store.md § ED-2): all SQL and bookkeeping
 * INSERTs run inside the same transaction. A failure anywhere — bad SQL,
 * filesystem error, conflict — rolls everything back. Half-applied state
 * is impossible.
 *
 * Concurrency: `BEGIN IMMEDIATE` acquires the write lock up front. Two
 * processes booting against the same fresh DB serialize through SQLite's
 * lock; the loser's `busy_timeout` waits for the winner to commit, then
 * its own SELECT sees the winner's `_migrations` rows and `pending` is
 * empty. Under the previous deferred design the loser snapshotted
 * `applied = {}` outside any txn, then attempted to re-apply migrations
 * the winner had already committed and threw `table already exists`.
 *
 * Idempotency: re-running on an already-migrated DB is a no-op. A crashed
 * mid-migration is recovered by re-running on next boot — no bookkeeping
 * row landed, so the file is retried from the top.
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

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(MIGRATION_FILE_SUFFIX))
    .sort();
  const insertStmt = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
  const selectAppliedStmt = db.prepare<[], MigrationRow>("SELECT name FROM _migrations");

  // Wrap discovery + apply in a BEGIN IMMEDIATE transaction so two
  // processes booting against the same fresh DB don't race. With the
  // pre-IMMEDIATE design the loser snapshotted `applied = {}`, then
  // re-ran a migration the winner had already committed and threw
  // `table already exists`. Under IMMEDIATE the loser blocks on the
  // write lock via `busy_timeout`; when it acquires the lock its own
  // SELECT sees the winner's bookkeeping rows and `pending` is empty.
  const txn = db.transaction(() => {
    const applied = new Set(selectAppliedStmt.all().map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));
    for (const filename of pending) {
      try {
        db.exec(readFileSync(join(dir, filename), "utf8"));
        insertStmt.run(filename, clock());
      } catch (err: unknown) {
        throw new MigrationError(
          filename,
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? { cause: err } : undefined,
        );
      }
    }
  });
  txn.immediate();
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

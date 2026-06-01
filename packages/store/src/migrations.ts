/**
 * Migration runner. Walks `packages/store/migrations/*.sql` in lex order and
 * applies any pending file inside a single `BEGIN IMMEDIATE` transaction
 * along with its `_migrations` bookkeeping row. Atomic + idempotent +
 * race-safe across processes. Per phases/03-store.md § ED-2.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "./db.js";

import { MigrationError, SchemaSkewError } from "./errors.js";

// Resolved from `import.meta.url`. The package ships `.ts` directly with no
// build step, so the relative `../migrations/` path holds at runtime.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const MIGRATION_FILE_SUFFIX = ".sql";

/** Lex-ordered migration filenames shipped with this build. */
const SHIPPED_MIGRATIONS = listMigrationFiles(MIGRATIONS_DIR);

export const SHIPPED_MIGRATION_COUNT = SHIPPED_MIGRATIONS.length;

/**
 * Optional dependencies for `runMigrations`.
 *
 * - `clock` — sets `_migrations.applied_at`. Defaults to system clock.
 * - `migrationsDir` — override for tests; production callers pass nothing.
 */
export interface RunMigrationsOptions {
  clock?: () => string;
  migrationsDir?: string;
}

interface MigrationRow {
  name: string;
}

// Locale-independent string comparator. Migrations apply in this order
// on every host regardless of `LANG` / collation settings.
function byteCompare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Applies any pending migrations in lexicographic filename order. Throws
 * `MigrationError` (with original SQLite error as `cause`) on failure;
 * partial transaction is rolled back so the next call retries from the top.
 */
export function runMigrations(db: Db, opts: RunMigrationsOptions = {}): void {
  const clock = opts.clock ?? defaultClock;
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;

  ensureBookkeepingTable(db);

  // Byte-wise comparator — migrations need deterministic ordering across
  // hosts. `localeCompare` would let host locale (e.g. de-DE vs en-US)
  // reorder filenames containing non-ASCII characters; sticking to UTF-16
  // code-unit comparison keeps the apply sequence stable everywhere.
  const files = listMigrationFiles(dir);
  const insertStmt = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
  const selectAppliedStmt = db.prepare<[], MigrationRow>("SELECT name FROM _migrations");

  // BEGIN IMMEDIATE acquires the write lock up front so two processes booting
  // against the same fresh DB don't race. The loser blocks on busy_timeout;
  // when it acquires the lock its SELECT sees the winner's bookkeeping rows.
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
 * Asserts `_migrations` reflects every migration file the build ships.
 * Call after `runMigrations` so a behind DB fails at open time instead of
 * surfacing as a downstream `no such column` on read.
 */
export function assertSchemaVersion(db: Db): void {
  const applied = db
    .prepare<[], MigrationRow>("SELECT name FROM _migrations ORDER BY name")
    .all()
    .map((r) => r.name);
  const dbCount = applied.length;
  const codeCount = SHIPPED_MIGRATION_COUNT;

  if (dbCount < codeCount) {
    throw new SchemaSkewError(dbCount, codeCount);
  }

  const appliedSet = new Set(applied);
  for (const migration of SHIPPED_MIGRATIONS) {
    if (!appliedSet.has(migration)) {
      throw new SchemaSkewError(dbCount, codeCount);
    }
  }

  // DB ahead of code (downgrade): applied rows exceed shipped files or include
  // names this build does not ship — surface as a plain Error for now.
  if (dbCount > codeCount) {
    throw new Error(
      `ship DB schema is ahead of the running code (DB at ${String(dbCount)}, code expects ${String(codeCount)}). Downgrade ship or migrate the DB forward.`,
    );
  }
}

function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(MIGRATION_FILE_SUFFIX))
    .sort(byteCompare);
}

function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * Defined here (not in `0001_init.sql`) so the migration files stay focused
 * on application schema.
 */
function ensureBookkeepingTable(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
}

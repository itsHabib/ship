-- 0005_driver_runs.sql — driver orchestration state (F2).
--
-- Three normalized tables for @ship/driver progress persistence:
--   driver_runs    : top-level run row; source_json holds the full manifest file.
--   driver_batches : batch rows with composite uniqueness for stream FK integrity.
--   driver_streams : per-stream progress; composite FK prevents cross-run batch refs.
--
-- Enum values are validated in zod at hydration time (0001 convention).

CREATE TABLE driver_runs (
  id            TEXT PRIMARY KEY,
  manifest_path TEXT NOT NULL,
  repo          TEXT NOT NULL,
  project       TEXT,
  phase         TEXT,
  status        TEXT NOT NULL,
  source_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX driver_runs_repo_idx       ON driver_runs (repo);
CREATE INDEX driver_runs_status_idx     ON driver_runs (status);
CREATE INDEX driver_runs_created_at_idx ON driver_runs (created_at DESC);

CREATE TABLE driver_batches (
  id             TEXT PRIMARY KEY,
  driver_run_id  TEXT NOT NULL REFERENCES driver_runs (id) ON DELETE CASCADE,
  batch_index    INTEGER NOT NULL,
  label          TEXT,
  depends_on     TEXT NOT NULL,
  status         TEXT NOT NULL,
  completed_at   TEXT,
  UNIQUE (driver_run_id, id)
);
CREATE INDEX driver_batches_run_idx ON driver_batches (driver_run_id);

CREATE TABLE driver_streams (
  id               TEXT PRIMARY KEY,
  driver_run_id    TEXT NOT NULL REFERENCES driver_runs (id) ON DELETE CASCADE,
  driver_batch_id  TEXT NOT NULL,
  task_id          TEXT,
  task_slug        TEXT,
  spec_path        TEXT NOT NULL,
  branch           TEXT,
  runtime          TEXT NOT NULL,
  touches          TEXT NOT NULL,
  status           TEXT NOT NULL,
  workflow_run_id  TEXT,
  attempts         TEXT NOT NULL,
  pr_number        INTEGER,
  pr_url           TEXT,
  merge_commit     TEXT,
  merged_at        TEXT,
  cycles           INTEGER,
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (driver_run_id, driver_batch_id)
    REFERENCES driver_batches (driver_run_id, id) ON DELETE CASCADE
);
CREATE INDEX driver_streams_run_idx    ON driver_streams (driver_run_id);
CREATE INDEX driver_streams_status_idx ON driver_streams (status);

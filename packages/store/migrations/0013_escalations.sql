-- 0013_escalations.sql — durable escalation rows for push-on-block.
--
-- Open-row-only dedup via partial unique index with COALESCE sentinels so
-- nullable driver_run_id / stream_id columns participate in uniqueness.

CREATE TABLE escalations (
  id             TEXT PRIMARY KEY,
  driver_run_id  TEXT REFERENCES driver_runs (id) ON DELETE CASCADE,
  stream_id      TEXT,
  repo           TEXT,
  class          TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  notified_at    TEXT,
  resolved_at    TEXT,
  resolution     TEXT
);

CREATE INDEX escalations_run_idx ON escalations (driver_run_id);
CREATE INDEX escalations_repo_idx ON escalations (repo);
CREATE INDEX escalations_class_idx ON escalations (class);
CREATE INDEX escalations_open_idx ON escalations (resolved_at) WHERE resolved_at IS NULL;

CREATE UNIQUE INDEX escalations_open_dedup_idx ON escalations (
  COALESCE(driver_run_id, ''),
  COALESCE(stream_id, ''),
  class
) WHERE resolved_at IS NULL;

CREATE UNIQUE INDEX driver_streams_run_id_id_idx
  ON driver_streams (driver_run_id, id);

CREATE TABLE driver_review_artifacts (
  artifact_id TEXT PRIMARY KEY,
  canonical_sha256 TEXT NOT NULL UNIQUE,
  driver_run_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  address_cycle INTEGER NOT NULL,
  doc_path TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  UNIQUE (driver_run_id, stream_id, address_cycle),
  FOREIGN KEY (driver_run_id, stream_id)
    REFERENCES driver_streams(driver_run_id, id) ON DELETE CASCADE
);

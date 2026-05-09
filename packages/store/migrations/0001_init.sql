-- 0001_init.sql — V1 schema for @ship/store.
--
-- Three normalized tables that round-trip @ship/workflow's hydrated entities:
--   workflow_runs : top-level run row, with worktree / policy as JSON blobs.
--   phases        : 0..N rows per run, FK with ON DELETE CASCADE.
--   cursor_runs   : 0..N rows per run, FK with ON DELETE CASCADE.
--
-- Indices match the access patterns documented in spec.md § "Data model" and
-- the listRuns / phase-hydration paths in phases/03-store.md § F3.
--
-- The _migrations bookkeeping table is created by the runner (migrations.ts),
-- not here, so this file remains "the actual schema" without bookkeeping bleed.

CREATE TABLE workflow_runs (
  id            TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  doc_path      TEXT NOT NULL,
  status        TEXT NOT NULL,
  base_ref      TEXT NOT NULL,
  worktree_json TEXT NOT NULL,
  policy_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX workflow_runs_repo_idx       ON workflow_runs (repo);
CREATE INDEX workflow_runs_status_idx     ON workflow_runs (status);
CREATE INDEX workflow_runs_created_at_idx ON workflow_runs (created_at DESC);

CREATE TABLE phases (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT,
  cursor_run_id   TEXT,
  input_json      TEXT NOT NULL,
  output_json     TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX phases_workflow_run_id_idx ON phases (workflow_run_id);

CREATE TABLE cursor_runs (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  runtime         TEXT NOT NULL,
  model_json      TEXT,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_ms     INTEGER,
  artifacts_dir   TEXT NOT NULL
);
CREATE INDEX cursor_runs_workflow_run_id_idx ON cursor_runs (workflow_run_id);

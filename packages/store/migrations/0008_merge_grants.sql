-- 0008_merge_grants.sql — repo-scoped merge-grant + per-PR satisfaction audit.
--
-- merge_grants: operator registers once per repo; authorizes --admin merges when
--   a structured MergeVerdict authorizes the PR.
-- merge_grant_satisfactions: per-PR audit row recording which grant + verdict
--   satisfied the admin tap for /shipped and downstream sessions.

CREATE TABLE merge_grants (
  id          TEXT PRIMARY KEY,
  repo        TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE UNIQUE INDEX merge_grants_active_repo_idx ON merge_grants (repo) WHERE revoked_at IS NULL;
CREATE INDEX merge_grants_repo_idx ON merge_grants (repo);

CREATE TABLE merge_grant_satisfactions (
  id                 TEXT PRIMARY KEY,
  grant_id           TEXT NOT NULL REFERENCES merge_grants (id),
  driver_run_id      TEXT NOT NULL REFERENCES driver_runs (id),
  driver_stream_id   TEXT NOT NULL REFERENCES driver_streams (id),
  pr_number          INTEGER NOT NULL,
  verdict_json       TEXT NOT NULL,
  merge_commit       TEXT NOT NULL,
  satisfied_at       TEXT NOT NULL
);
CREATE INDEX merge_grant_satisfactions_grant_idx ON merge_grant_satisfactions (grant_id);
CREATE INDEX merge_grant_satisfactions_stream_idx ON merge_grant_satisfactions (driver_stream_id);

-- 0008_merge_grants.sql — repo-scoped merge-grant policy persistence.
--
-- repo_merge_grants: one active grant per repo (owner/repo slug).
-- merge_grant_satisfactions: per-PR audit when land() satisfies --admin via grant.

CREATE TABLE repo_merge_grants (
  id          TEXT PRIMARY KEY,
  repo        TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE UNIQUE INDEX repo_merge_grants_active_repo_uq
  ON repo_merge_grants (repo) WHERE revoked_at IS NULL;
CREATE INDEX repo_merge_grants_repo_idx ON repo_merge_grants (repo);

CREATE TABLE merge_grant_satisfactions (
  id                TEXT PRIMARY KEY,
  grant_id          TEXT NOT NULL REFERENCES repo_merge_grants (id),
  repo              TEXT NOT NULL,
  pr_number         INTEGER NOT NULL,
  driver_run_id     TEXT,
  driver_stream_id  TEXT,
  verdict_json      TEXT NOT NULL,
  merge_commit      TEXT,
  satisfied_at      TEXT NOT NULL,
  UNIQUE (repo, pr_number)
);
CREATE INDEX merge_grant_satisfactions_repo_pr_idx
  ON merge_grant_satisfactions (repo, pr_number);

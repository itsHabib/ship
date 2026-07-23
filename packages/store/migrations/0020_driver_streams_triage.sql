-- 0020_driver_streams_triage.sql — per-stream triage-floor classification
-- (review-credit-tiering spec, driver-triage-tier phase).
--
-- The driver shells out `gh pr diff <n> -R <owner>/<name> | triage-floor` when it
-- first observes a stream's PR (and re-runs whenever the head moves), then
-- persists the outcome here so resume/status keep it without re-classifying.
--
-- triage_tier: the classified T0–T3 risk tier. NULL when unclassified or when
--   the classifier failed — a failure is NEVER a fabricated tier.
-- triage_tier_source: "classified" (a tier was parsed) or "classifier_error"
--   (missing binary / non-zero exit / timeout / unparseable output — no tier).
--   NULL read as never-attempted.
-- triage_head_sha: the PR head the tier binds to. The tier is re-computed when
--   this no longer matches the live head (fix commits can change the risk class).
--
-- All additive + nullable: existing driver DBs open unchanged.
ALTER TABLE driver_streams ADD COLUMN triage_tier TEXT;
ALTER TABLE driver_streams ADD COLUMN triage_tier_source TEXT;
ALTER TABLE driver_streams ADD COLUMN triage_head_sha TEXT;

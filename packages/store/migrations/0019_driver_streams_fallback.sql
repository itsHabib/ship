-- 0019_driver_streams_fallback.sql — per-stream fallback dispatch chain
-- (dispatch-fallback spec §5).
--
-- fallback_chain: JSON array of {runtime, provider, modelId?} targets, frozen at
--   import (resolution of a stream's `fallback` + the run `default_fallback`).
--   NULL for streams with no chain — read as absent (feature is opt-in).
-- fallback_cursor: next chain index to try; NULL read as absent (no chain).
-- fallback_log: append-only JSON array of hop/skip/retry records; NULL read as
--   absent. Import writes all three columns together (or none) — a chainless
--   row stays all-NULL. No log record is written until P2a (engine hop); the
--   column ships now so the walk has nowhere new to migrate to later.
--
-- All additive + nullable: existing driver DBs open unchanged (spec §2 Compat).
ALTER TABLE driver_streams ADD COLUMN fallback_chain TEXT;
ALTER TABLE driver_streams ADD COLUMN fallback_cursor INTEGER;
ALTER TABLE driver_streams ADD COLUMN fallback_log TEXT;

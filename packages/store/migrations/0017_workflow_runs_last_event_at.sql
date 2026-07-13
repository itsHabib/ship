-- 0017_workflow_runs_last_event_at.sql — remote-event progress anchor.
--
-- The driver tick's #157 inactivity give-up reads `updated_at` as its progress
-- signal, but the event pump's 30s timer bumps `updated_at` for freshness even
-- when a remote run has gone silent — so a hung cloud run looked perpetually
-- live. `last_event_at` moves ONLY on a real agent event (never on the timer),
-- giving the tick a signal that reflects remote progress rather than pump
-- liveness. `updated_at` keeps its freshness semantics untouched (orphan-resume
-- staleness + prune still read it). Defaults NULL for existing rows and for
-- local runs (which have no pump); the driver reads `last_event_at ?? updated_at`
-- so those rows fall back to the old behavior.

ALTER TABLE workflow_runs ADD COLUMN last_event_at TEXT;

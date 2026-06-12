-- 0006_driver_tick_lease.sql — tick lease columns for @ship/driver engine (§8).
--
-- Nullable TEXT timestamps on driver_runs; the engine stamps start/end on
-- every tick entry/exit. Not a distributed lock — same trust level as the
-- local workbench.

ALTER TABLE driver_runs ADD COLUMN tick_started_at TEXT;
ALTER TABLE driver_runs ADD COLUMN tick_ended_at TEXT;

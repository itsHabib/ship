-- 0016_driver_streams_rolls_up.sql — collapsed-stream → rolled-up task ids.
--
-- A stream that stands in for several dossier tasks carries their ids here so
-- the engine can close all of them at land time (the `task_complete` fan-out
-- itself stays skill-side). Stored as a JSON array of task-id strings; defaults
-- NULL for existing rows (read as absent — no rolled-up tasks).

ALTER TABLE driver_streams ADD COLUMN rolls_up TEXT;

-- 0010_driver_streams_provider.sql — per-stream requested provider persistence.
--
-- Requested provider is resolved at import (stream > manifest default > none).
-- Dispatch provider is written separately when the engine starts a ship run.

ALTER TABLE driver_streams ADD COLUMN provider TEXT;

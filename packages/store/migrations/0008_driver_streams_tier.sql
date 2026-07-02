-- 0008_driver_streams_tier.sql — per-stream model/effort tier persistence (F2).
--
-- Requested tiers are resolved at import (stream > manifest default > none).
-- Dispatch mapping + degrade flags are written when the engine starts a ship run.

ALTER TABLE driver_streams ADD COLUMN model_tier TEXT;
ALTER TABLE driver_streams ADD COLUMN effort_tier TEXT;
ALTER TABLE driver_streams ADD COLUMN dispatch_provider TEXT;
ALTER TABLE driver_streams ADD COLUMN dispatch_model TEXT;
ALTER TABLE driver_streams ADD COLUMN dispatch_model_params TEXT;
ALTER TABLE driver_streams ADD COLUMN effort_degraded INTEGER;
ALTER TABLE driver_streams ADD COLUMN tier_degrade_reason TEXT;

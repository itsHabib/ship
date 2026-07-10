-- 0014_driver_streams_review_cycles.sql — engine-owned review-cycle counter.
--
-- Incremented once per `driver address` re-dispatch. Distinct from `cycles`
-- (0005), the seat-reported coordinator-pass count written at merge time: this
-- one is the engine's re-dispatch budget, capped at maxCycles. Defaults NULL
-- for existing rows (read as 0).

ALTER TABLE driver_streams ADD COLUMN review_cycles INTEGER;

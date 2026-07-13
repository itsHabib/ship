-- Requested verbatim provider catalog id (model-lottery spec §3.5).
-- Nullable: tier-only streams predate and outlive this column;
-- dispatch_model keeps recording what actually went out.
ALTER TABLE driver_streams ADD COLUMN model_id TEXT;

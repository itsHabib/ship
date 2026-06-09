-- 0004_phases_failure_category.sql — nullable failure classification on phases.
ALTER TABLE phases ADD COLUMN failure_category TEXT;

-- 0008_cursor_runs_created_at_ms.sql — provider server-stamped run creation time.
-- Nullable: local rows and pre-migration cloud rows have no server anchor.

ALTER TABLE cursor_runs ADD COLUMN created_at_ms INTEGER;

-- 0007_cursor_runs_provider.sql — agent provider axis on cursor_runs.
-- Default 'cursor' backfills existing rows; Phase 1 is additive-only.

ALTER TABLE cursor_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'cursor';

-- Persist the Cursor SDK run id (`run-<uuid>`) alongside agent_id so
-- Ship can call `Agent.getRun(runId, ...)` on process restart.
ALTER TABLE cursor_runs ADD COLUMN run_id TEXT;

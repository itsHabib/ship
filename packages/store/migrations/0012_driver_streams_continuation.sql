-- 0012_driver_streams_continuation.sql — persist cloud branch-continuation intent.
--
-- When true, cloud dispatch checks out `branch` via startingRef/workOnCurrentBranch
-- instead of starting fresh from the repo default branch. Set by flip-cloud and
-- optional manifest import; survives retry re-dispatch.

ALTER TABLE driver_streams ADD COLUMN work_on_current_branch INTEGER;

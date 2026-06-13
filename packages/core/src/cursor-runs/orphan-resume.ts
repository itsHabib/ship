/**
 * Staleness-guarded orphan resume candidate selection for
 * `ShipService.resumeOrphanedRuns`. Fresh `workflow_runs.updated_at`
 * rows belong to a sibling process's live run; only stale rows are
 * eligible for attach on startup.
 */

/** Rows older than this threshold are orphan-resume candidates (~5 minutes). */
export const ORPHAN_RESUME_STALENESS_MS = 5 * 60 * 1000;

/** Minimal row shape for the pure staleness filter. */
export interface OrphanResumeCandidate {
  readonly workflowRunId: string;
  readonly updatedAt: string;
}

/**
 * Returns rows whose parent workflow `updatedAt` is older than the
 * staleness threshold relative to `nowMs`. Fresh rows are skipped —
 * they are another process's actively-streamed run.
 */
export function selectStaleOrphanResumeCandidates(
  rows: readonly OrphanResumeCandidate[],
  nowMs: number,
): OrphanResumeCandidate[] {
  const cutoffMs = nowMs - ORPHAN_RESUME_STALENESS_MS;
  return rows.filter((row) => Date.parse(row.updatedAt) <= cutoffMs);
}

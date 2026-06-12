import { describe, expect, test } from "vitest";

import {
  ORPHAN_RESUME_STALENESS_MS,
  type OrphanResumeCandidate,
  selectStaleOrphanResumeCandidates,
} from "./orphan-resume.js";

describe("selectStaleOrphanResumeCandidates", () => {
  const nowMs = Date.parse("2026-06-12T12:00:00.000Z");

  test("excludes rows with fresh updatedAt", () => {
    const rows: OrphanResumeCandidate[] = [
      {
        workflowRunId: "wf_fresh",
        updatedAt: new Date(nowMs - ORPHAN_RESUME_STALENESS_MS + 60_000).toISOString(),
      },
    ];
    expect(selectStaleOrphanResumeCandidates(rows, nowMs)).toEqual([]);
  });

  test("includes rows with stale updatedAt", () => {
    const staleAt = new Date(nowMs - ORPHAN_RESUME_STALENESS_MS - 1).toISOString();
    const rows: OrphanResumeCandidate[] = [{ workflowRunId: "wf_stale", updatedAt: staleAt }];
    expect(selectStaleOrphanResumeCandidates(rows, nowMs)).toEqual(rows);
  });

  test("includes rows exactly at the staleness boundary", () => {
    const boundaryAt = new Date(nowMs - ORPHAN_RESUME_STALENESS_MS).toISOString();
    const rows: OrphanResumeCandidate[] = [{ workflowRunId: "wf_boundary", updatedAt: boundaryAt }];
    expect(selectStaleOrphanResumeCandidates(rows, nowMs)).toEqual(rows);
  });
});

/**
 * Narrow GitHub port for driver policy verbs (merge + read).
 */

export interface GhMergeCommit {
  oid: string;
}

export interface GhPullRequestView {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeCommit?: GhMergeCommit | null;
  mergedAt?: string | null;
}

export interface DriverGhPort {
  mergePullRequest(repo: string, prNumber: number): Promise<void>;
  viewPullRequest(repo: string, prNumber: number): Promise<GhPullRequestView>;
}

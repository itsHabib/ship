/** In-memory gh port for driver land tests. */

import type {
  DriverGhPort,
  GhMergeOpts,
  GhPrCheck,
  GhPrMergeGateFacts,
  GhPrReadiness,
  GhPullRequestView,
  GhReviewEntry,
} from "../gh-port.js";

export interface FakeGhPrState {
  state: GhPullRequestView["state"];
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
  /** Readiness facts the land guard reads via `fetchPrReadiness`. */
  isDraft?: boolean;
  /** Conflict state; defaults to MERGEABLE when omitted. */
  mergeable?: string;
  /** statusCheckRollup, normalized. Defaults to a single green check. */
  checks?: GhPrCheck[];
  /** Head commit oid for merge-gate assembly. */
  ciSha?: string;
  /** gh review entries for merge-gate assembly. */
  reviews?: GhReviewEntry[];
  /** After merge, return a stale OPEN view this many times before the merged state. */
  postMergeViewLagReads?: number;
}

export interface FakeGhPort extends DriverGhPort {
  mergeCalls: { repo: string; prNumber: number; admin: boolean }[];
  viewCalls: { repo: string; prNumber: number }[];
}

export function createFakeGhPort(initial: Record<number, FakeGhPrState> = {}): FakeGhPort {
  const prs = new Map<number, FakeGhPrState>(
    Object.entries(initial).map(([k, v]) => [Number(k), v]),
  );
  const mergeCalls: { repo: string; prNumber: number; admin: boolean }[] = [];
  const viewCalls: { repo: string; prNumber: number }[] = [];
  const postMergeLagRemaining = new Map<number, number>();

  return {
    mergeCalls,
    viewCalls,
    mergePullRequest(_repo: string, prNumber: number, opts?: GhMergeOpts): Promise<void> {
      mergeCalls.push({ admin: opts?.admin === true, prNumber, repo: _repo });
      const current = prs.get(prNumber);
      const lagReads = current?.postMergeViewLagReads ?? 0;
      if (lagReads > 0) {
        postMergeLagRemaining.set(prNumber, lagReads);
      }
      if (current === undefined) {
        prs.set(prNumber, {
          mergeCommit: { oid: "fake-merge-sha" },
          mergedAt: new Date().toISOString(),
          state: "MERGED",
        });
        return Promise.resolve();
      }
      prs.set(prNumber, {
        ...current,
        mergeCommit: current.mergeCommit ?? { oid: "fake-merge-sha" },
        mergedAt: current.mergedAt ?? new Date().toISOString(),
        state: "MERGED",
      });
      return Promise.resolve();
    },
    viewPullRequest(_repo: string, prNumber: number): Promise<GhPullRequestView> {
      viewCalls.push({ prNumber, repo: _repo });
      const lagLeft = postMergeLagRemaining.get(prNumber) ?? 0;
      if (lagLeft > 0) {
        postMergeLagRemaining.set(prNumber, lagLeft - 1);
        return Promise.resolve({ mergeCommit: null, mergedAt: null, state: "OPEN" });
      }
      const current = prs.get(prNumber);
      if (current === undefined) {
        return Promise.resolve({ state: "OPEN", mergeCommit: null, mergedAt: null });
      }
      return Promise.resolve(current);
    },
    fetchPrReadiness(_repo: string, prNumber: number): Promise<GhPrReadiness> {
      return Promise.resolve(buildFakeMergeGateFacts(prs, prNumber).readiness);
    },
    fetchPrMergeGateFacts(_repo: string, prNumber: number): Promise<GhPrMergeGateFacts> {
      return Promise.resolve(buildFakeMergeGateFacts(prs, prNumber));
    },
  };
}

function buildFakeMergeGateFacts(
  prs: Map<number, FakeGhPrState>,
  prNumber: number,
): GhPrMergeGateFacts {
  const current = prs.get(prNumber);
  return {
    ciSha: current?.ciSha ?? "fake-head-sha",
    readiness: buildFakeReadiness(current),
    reviews: current?.reviews ?? defaultApprovedReviews(),
  };
}

function buildFakeReadiness(current: FakeGhPrState | undefined): GhPrReadiness {
  return {
    checks: current?.checks ?? [defaultGreenCheck()],
    isDraft: current?.isDraft === true,
    mergeable: current?.mergeable ?? "MERGEABLE",
    state: current?.state ?? "OPEN",
  };
}

function defaultGreenCheck(): GhPrCheck {
  return { conclusion: "SUCCESS", name: "ci", status: "COMPLETED" };
}

function defaultApprovedReviews(): GhReviewEntry[] {
  return [
    { authorLogin: "codex-bot", state: "APPROVED" },
    { authorLogin: "claude-bot", state: "APPROVED" },
    { authorLogin: "copilot-pull-request-reviewer", state: "APPROVED" },
  ];
}

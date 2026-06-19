/** In-memory gh port for driver land tests. */

import type {
  DriverGhPort,
  GhMergeOpts,
  GhPrCheck,
  GhPrReadiness,
  GhPullRequestView,
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
}

export interface FakeGhPort extends DriverGhPort {
  mergeCalls: { repo: string; prNumber: number; admin: boolean }[];
}

export function createFakeGhPort(initial: Record<number, FakeGhPrState> = {}): FakeGhPort {
  const prs = new Map<number, FakeGhPrState>(
    Object.entries(initial).map(([k, v]) => [Number(k), v]),
  );
  const mergeCalls: { repo: string; prNumber: number; admin: boolean }[] = [];

  return {
    mergeCalls,
    mergePullRequest(_repo: string, prNumber: number, opts?: GhMergeOpts): Promise<void> {
      mergeCalls.push({ admin: opts?.admin === true, prNumber, repo: _repo });
      const current = prs.get(prNumber);
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
      const current = prs.get(prNumber);
      if (current === undefined) {
        return Promise.resolve({ state: "OPEN", mergeCommit: null, mergedAt: null });
      }
      return Promise.resolve(current);
    },
    fetchPrReadiness(_repo: string, prNumber: number): Promise<GhPrReadiness> {
      const current = prs.get(prNumber);
      const state = current?.state ?? "OPEN";
      const greenCheck: GhPrCheck = {
        conclusion: "SUCCESS",
        name: "ci",
        status: "COMPLETED",
      };
      return Promise.resolve({
        checks: current?.checks ?? [greenCheck],
        isDraft: current?.isDraft === true,
        mergeable: current?.mergeable ?? "MERGEABLE",
        state,
      });
    },
  };
}

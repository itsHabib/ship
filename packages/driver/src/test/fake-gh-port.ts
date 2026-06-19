/** In-memory gh port for driver land tests. */

import type { DriverGhPort, GhMergeOpts, GhPullRequestView } from "../gh-port.js";

export interface FakeGhPrState {
  state: GhPullRequestView["state"];
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
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
  };
}

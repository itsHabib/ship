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
  headRefOid?: string;
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
  /** Readiness facts the land guard reads via `fetchPrReadiness`. */
  isDraft?: boolean;
  /** Conflict state; defaults to MERGEABLE when omitted. */
  mergeable?: string;
  /** statusCheckRollup, normalized. Defaults to a single green check. */
  checks?: GhPrCheck[];
  /** After merge, return a stale OPEN view this many times before the merged state. */
  postMergeViewLagReads?: number;
  /** When set, `markReady` throws with this message. */
  markReadyError?: string;
  /** When true, `markReady` leaves the PR draft (simulates unconfirmed flip). */
  markReadyUnconfirmed?: boolean;
}

export interface FakeGhPort extends DriverGhPort {
  mergeCalls: { repo: string; prNumber: number; admin: boolean }[];
  viewCalls: { repo: string; prNumber: number }[];
  markReadyCalls: { repo: string; prNumber: number }[];
  /** Mutate the in-memory PR state between calls (e.g., advance headRefOid). */
  setPrState: (prNumber: number, state: FakeGhPrState) => void;
}

export function createFakeGhPort(initial: Record<number, FakeGhPrState> = {}): FakeGhPort {
  const prs = new Map<number, FakeGhPrState>(
    Object.entries(initial).map(([k, v]) => [Number(k), v]),
  );
  const mergeCalls: { repo: string; prNumber: number; admin: boolean }[] = [];
  const viewCalls: { repo: string; prNumber: number }[] = [];
  const markReadyCalls: { repo: string; prNumber: number }[] = [];
  const postMergeLagRemaining = new Map<number, number>();

  return {
    markReadyCalls,
    mergeCalls,
    viewCalls,
    setPrState(prNumber: number, state: FakeGhPrState): void {
      prs.set(prNumber, state);
    },
    mergePullRequest(_repo: string, prNumber: number, opts?: GhMergeOpts): Promise<void> {
      mergeCalls.push({ admin: opts?.admin === true, prNumber, repo: _repo });
      const current = prs.get(prNumber);
      const lagReads = current?.postMergeViewLagReads ?? 0;
      if (lagReads > 0) {
        postMergeLagRemaining.set(prNumber, lagReads);
      }
      if (current === undefined) {
        prs.set(prNumber, {
          headRefOid: "0000000000000000000000000000000000000000",
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
        return Promise.resolve({
          headRefOid: "0000000000000000000000000000000000000000",
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        });
      }
      const current = prs.get(prNumber);
      if (current === undefined) {
        return Promise.resolve({
          headRefOid: "0000000000000000000000000000000000000000",
          state: "OPEN",
          mergeCommit: null,
          mergedAt: null,
        });
      }
      return Promise.resolve({
        ...current,
        headRefOid: current.headRefOid ?? "0000000000000000000000000000000000000000",
      });
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
    markReady(_repo: string, prNumber: number): Promise<void> {
      markReadyCalls.push({ prNumber, repo: _repo });
      const current = prs.get(prNumber);
      if (current?.markReadyError !== undefined) {
        return Promise.reject(new Error(current.markReadyError));
      }
      if (current?.isDraft !== true) {
        return Promise.resolve();
      }
      if (current.markReadyUnconfirmed === true) {
        return Promise.reject(
          new Error(`PR #${String(prNumber)} is still draft after gh pr ready — flip unconfirmed`),
        );
      }
      prs.set(prNumber, { ...current, isDraft: false });
      return Promise.resolve();
    },
  };
}

/** Land verb — merge, read gh facts, record via markMerged. */

import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DecideError } from "./errors.js";
import { toGhRepo } from "./gh-port.js";
import { land } from "./land.js";
import { createFakeGhPort } from "./test/fake-gh-port.js";

describe("land", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test("merges and records a landed stream's open PR", async () => {
    const streamId = newDriverStreamId();
    const runId = seedLandedRun(store, streamId, {
      prUrl: "https://github.com/org/ship/pull/42",
    });
    const gh = createFakeGhPort({
      42: { mergeCommit: null, mergedAt: null, state: "OPEN" },
    });

    const run = await land(store, gh, runId, { prNumber: 42 });
    const stream = run.batches[0]?.streams[0];

    expect(gh.mergeCalls).toHaveLength(1);
    expect(gh.mergeCalls[0]?.prNumber).toBe(42);
    // --admin is opt-in: the default land path merges without it.
    expect(gh.mergeCalls[0]?.admin).toBe(false);
    expect(stream?.status).toBe("done");
    expect(stream?.prNumber).toBe(42);
    expect(stream?.mergeCommit).toBe("fake-merge-sha");
    expect(stream?.mergedAt).toBeDefined();
  });

  test("threads admin:true through to the merge", async () => {
    const streamId = newDriverStreamId();
    const runId = seedLandedRun(store, streamId, {
      prUrl: "https://github.com/org/ship/pull/43",
    });
    const gh = createFakeGhPort({
      43: { mergeCommit: null, mergedAt: null, state: "OPEN" },
    });

    await land(store, gh, runId, { admin: true, prNumber: 43 });

    expect(gh.mergeCalls).toHaveLength(1);
    expect(gh.mergeCalls[0]?.admin).toBe(true);
  });

  test("records an already-MERGED PR without re-merging", async () => {
    const streamId = newDriverStreamId();
    const runId = seedLandedRun(store, streamId, {
      prUrl: "https://github.com/org/ship/pull/7",
    });
    const gh = createFakeGhPort({
      7: {
        mergeCommit: { oid: "abc123deadbeef" },
        mergedAt: "2026-06-12T01:00:00.000Z",
        state: "MERGED",
      },
    });

    const run = await land(store, gh, runId, { prNumber: 7 });

    expect(gh.mergeCalls).toEqual([]);
    expect(run.batches[0]?.streams[0]?.mergeCommit).toBe("abc123deadbeef");
    expect(run.batches[0]?.streams[0]?.mergedAt).toBe("2026-06-12T01:00:00.000Z");
  });

  test("resolves the stream from --pr via prUrl parsing", async () => {
    const streamId = newDriverStreamId();
    const runId = seedLandedRun(store, streamId, {
      prUrl: "https://github.com/org/ship/pull/99",
    });
    const gh = createFakeGhPort({
      99: {
        mergeCommit: { oid: "sha99" },
        mergedAt: "2026-06-12T02:00:00.000Z",
        state: "MERGED",
      },
    });

    const run = await land(store, gh, runId, { prNumber: 99 });
    expect(run.batches[0]?.streams[0]?.id).toBe(streamId);
  });

  test("resolves an already-done stream from --pr (idempotent re-land)", async () => {
    const streamId = newDriverStreamId();
    const runId = seedDoneRun(store, streamId, "https://github.com/org/ship/pull/77");
    const gh = createFakeGhPort({
      77: {
        mergeCommit: { oid: "sha77" },
        mergedAt: "2026-06-12T05:00:00.000Z",
        state: "MERGED",
      },
    });

    const run = await land(store, gh, runId, { prNumber: 77 });
    // The stream was already `done`; resolving by --pr must not throw.
    expect(run.batches[0]?.streams[0]?.id).toBe(streamId);
    expect(run.batches[0]?.streams[0]?.status).toBe("done");
    expect(gh.mergeCalls).toEqual([]);
  });

  test("resolves stream via explicit streamId fallback", async () => {
    const streamId = newDriverStreamId();
    const runId = seedLandedRun(store, streamId, {});
    const gh = createFakeGhPort({
      3: {
        mergeCommit: { oid: "sha3" },
        mergedAt: "2026-06-12T03:00:00.000Z",
        state: "MERGED",
      },
    });

    const run = await land(store, gh, runId, { prNumber: 3, streamId });
    expect(run.batches[0]?.streams[0]?.status).toBe("done");
  });

  test("errors when neither --pr (no prUrl) nor --stream resolves", async () => {
    const streamId = newDriverStreamId();
    const runId = seedLandedRun(store, streamId, {});
    const gh = createFakeGhPort();

    await expect(land(store, gh, runId, { prNumber: 5 })).rejects.toThrow(DecideError);
    await expect(land(store, gh, runId, { prNumber: 5 })).rejects.toThrow(/pass --stream/);
  });

  test("errors when stream is not in a landable state", async () => {
    const streamId = newDriverStreamId();
    const runId = store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: newDriverBatchId(),
          status: "running",
          streams: [
            {
              attempts: [],
              id: streamId,
              prUrl: "https://github.com/org/ship/pull/11",
              runtime: "cloud",
              specPath: "a.md",
              status: "dispatched",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
      ],
      id: newDriverRunId(),
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: minimalSource(),
      status: "running",
    }).id;
    const gh = createFakeGhPort();

    await expect(land(store, gh, runId, { prNumber: 11, streamId })).rejects.toThrow(
      /is not in a landable state \(expected landed or done; got dispatched\)/,
    );
  });

  describe("readiness guard", () => {
    test("passes a green, non-draft, conflict-free PR (merge proceeds)", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/100",
      });
      const gh = createFakeGhPort({
        100: {
          checks: [{ conclusion: "SUCCESS", name: "ci", status: "COMPLETED" }],
          isDraft: false,
          mergeCommit: null,
          mergeable: "MERGEABLE",
          mergedAt: null,
          state: "OPEN",
        },
      });

      const run = await land(store, gh, runId, { prNumber: 100 });

      expect(gh.mergeCalls).toHaveLength(1);
      expect(gh.mergeCalls[0]?.prNumber).toBe(100);
      expect(run.batches[0]?.streams[0]?.status).toBe("done");
    });

    test("blocks a draft PR", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/101",
      });
      const gh = createFakeGhPort({
        101: { isDraft: true, mergeCommit: null, mergedAt: null, state: "OPEN" },
      });

      await expect(land(store, gh, runId, { prNumber: 101 })).rejects.toThrow(
        /refusing to merge PR #101: not ready — draft/,
      );
      expect(gh.mergeCalls).toEqual([]);
    });

    test("blocks a PR with a FAILURE check", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/102",
      });
      const gh = createFakeGhPort({
        102: {
          checks: [
            { conclusion: "SUCCESS", name: "lint", status: "COMPLETED" },
            { conclusion: "FAILURE", name: "test", status: "COMPLETED" },
          ],
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        },
      });

      await expect(land(store, gh, runId, { prNumber: 102 })).rejects.toThrow(
        /refusing to merge PR #102: not ready — failing checks: test/,
      );
      expect(gh.mergeCalls).toEqual([]);
    });

    test("blocks a PR with an IN_PROGRESS check", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/103",
      });
      const gh = createFakeGhPort({
        103: {
          checks: [
            { conclusion: "SUCCESS", name: "lint", status: "COMPLETED" },
            { conclusion: "", name: "test", status: "IN_PROGRESS" },
          ],
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        },
      });

      await expect(land(store, gh, runId, { prNumber: 103 })).rejects.toThrow(
        /refusing to merge PR #103: not ready — checks still running: test/,
      );
      expect(gh.mergeCalls).toEqual([]);
    });

    test("blocks a PR with merge conflicts (mergeable !== MERGEABLE)", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/104",
      });
      const gh = createFakeGhPort({
        104: {
          mergeable: "CONFLICTING",
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        },
      });

      await expect(land(store, gh, runId, { prNumber: 104 })).rejects.toThrow(
        /refusing to merge PR #104: not ready — merge conflicts/,
      );
      expect(gh.mergeCalls).toEqual([]);
    });

    test("skips the guard for an already-MERGED PR (records facts, no readiness error)", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/105",
      });
      // Draft + conflicting + red, yet MERGED — the guard must not fire.
      const gh = createFakeGhPort({
        105: {
          checks: [{ conclusion: "FAILURE", name: "test", status: "COMPLETED" }],
          isDraft: true,
          mergeable: "CONFLICTING",
          mergeCommit: { oid: "merged-sha" },
          mergedAt: "2026-06-12T06:00:00.000Z",
          state: "MERGED",
        },
      });

      const run = await land(store, gh, runId, { prNumber: 105 });

      expect(gh.mergeCalls).toEqual([]);
      expect(run.batches[0]?.streams[0]?.mergeCommit).toBe("merged-sha");
      expect(run.batches[0]?.streams[0]?.mergedAt).toBe("2026-06-12T06:00:00.000Z");
    });

    test("composes with --admin: guard still runs, green PR merges with --admin", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/106",
      });
      const gh = createFakeGhPort({
        106: {
          checks: [{ conclusion: "SUCCESS", name: "ci", status: "COMPLETED" }],
          mergeable: "MERGEABLE",
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        },
      });

      await land(store, gh, runId, { admin: true, prNumber: 106 });

      expect(gh.mergeCalls).toHaveLength(1);
      expect(gh.mergeCalls[0]?.admin).toBe(true);
    });

    test("admin:true still blocks an unready (draft) PR", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/107",
      });
      const gh = createFakeGhPort({
        107: { isDraft: true, mergeCommit: null, mergedAt: null, state: "OPEN" },
      });

      await expect(land(store, gh, runId, { admin: true, prNumber: 107 })).rejects.toThrow(
        /refusing to merge PR #107: not ready — draft/,
      );
      expect(gh.mergeCalls).toEqual([]);
    });

    test("allows a PR whose only check is SKIPPED (merge proceeds)", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/108",
      });
      const gh = createFakeGhPort({
        108: {
          checks: [{ conclusion: "SKIPPED", name: "optional", status: "COMPLETED" }],
          mergeable: "MERGEABLE",
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        },
      });

      const run = await land(store, gh, runId, { prNumber: 108 });

      expect(gh.mergeCalls).toHaveLength(1);
      expect(run.batches[0]?.streams[0]?.status).toBe("done");
    });

    test("allows a PR whose only check is NEUTRAL (merge proceeds)", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/109",
      });
      const gh = createFakeGhPort({
        109: {
          checks: [{ conclusion: "NEUTRAL", name: "advisory", status: "COMPLETED" }],
          mergeable: "MERGEABLE",
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        },
      });

      const run = await land(store, gh, runId, { prNumber: 109 });

      expect(gh.mergeCalls).toHaveLength(1);
      expect(run.batches[0]?.streams[0]?.status).toBe("done");
    });

    test("blocks a PR with a QUEUED check (still running)", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/110",
      });
      const gh = createFakeGhPort({
        110: {
          checks: [{ conclusion: "", name: "test", status: "QUEUED" }],
          mergeable: "MERGEABLE",
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        },
      });

      await expect(land(store, gh, runId, { prNumber: 110 })).rejects.toThrow(
        /refusing to merge PR #110: not ready — checks still running: test/,
      );
      expect(gh.mergeCalls).toEqual([]);
    });

    test("allows a PR with UNKNOWN mergeability (still computing, not a conflict)", async () => {
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/111",
      });
      const gh = createFakeGhPort({
        111: {
          checks: [{ conclusion: "SUCCESS", name: "ci", status: "COMPLETED" }],
          mergeable: "UNKNOWN",
          mergeCommit: null,
          mergedAt: null,
          state: "OPEN",
        },
      });

      const run = await land(store, gh, runId, { prNumber: 111 });

      expect(gh.mergeCalls).toHaveLength(1);
      expect(run.batches[0]?.streams[0]?.status).toBe("done");
    });
  });

  describe("post-merge view lag", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test("retries when the first post-merge view is still OPEN", async () => {
      vi.useFakeTimers();
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/50",
      });
      const gh = createFakeGhPort({
        50: { mergeCommit: null, mergedAt: null, postMergeViewLagReads: 1, state: "OPEN" },
      });

      const promise = land(store, gh, runId, { prNumber: 50 });
      await vi.runAllTimersAsync();
      const run = await promise;

      expect(gh.viewCalls).toHaveLength(3);
      expect(run.batches[0]?.streams[0]?.status).toBe("done");
      expect(run.batches[0]?.streams[0]?.mergeCommit).toBe("fake-merge-sha");
    });

    test("errors when post-merge view never reaches MERGED", async () => {
      vi.useFakeTimers();
      const streamId = newDriverStreamId();
      const runId = seedLandedRun(store, streamId, {
        prUrl: "https://github.com/org/ship/pull/51",
      });
      const gh = createFakeGhPort({
        51: { mergeCommit: null, mergedAt: null, postMergeViewLagReads: 3, state: "OPEN" },
      });

      const promise = land(store, gh, runId, { prNumber: 51 });
      const expectation = expect(promise).rejects.toThrow(/PR #51 is not merged \(state=OPEN\)/);
      await vi.runAllTimersAsync();
      await expectation;
      expect(gh.viewCalls).toHaveLength(4);
    });
  });

  describe("resolveStreamByPr repo scoping", () => {
    test("resolves the stream whose prUrl repo matches the run repo", async () => {
      const targetStreamId = newDriverStreamId();
      const otherStreamId = newDriverStreamId();
      const runId = seedMultiStreamRun(store, [
        {
          id: targetStreamId,
          prUrl: "https://github.com/org/ship/pull/60",
          status: "landed",
        },
        {
          id: otherStreamId,
          prUrl: "https://github.com/org/other/pull/60",
          status: "landed",
        },
      ]);
      const gh = createFakeGhPort({
        60: {
          mergeCommit: { oid: "sha60" },
          mergedAt: "2026-06-12T07:00:00.000Z",
          state: "MERGED",
        },
      });

      const run = await land(store, gh, runId, { prNumber: 60 });
      expect(run.batches[0]?.streams[0]?.id).toBe(targetStreamId);
    });

    test("errors when no stream matches both repo and PR number", async () => {
      const streamId = newDriverStreamId();
      const runId = seedMultiStreamRun(store, [
        {
          id: streamId,
          prUrl: "https://github.com/org/other/pull/61",
          status: "landed",
        },
      ]);
      const gh = createFakeGhPort({
        61: {
          mergeCommit: { oid: "sha61" },
          mergedAt: "2026-06-12T07:00:00.000Z",
          state: "MERGED",
        },
      });

      await expect(land(store, gh, runId, { prNumber: 61 })).rejects.toThrow(
        /no landed stream matches/,
      );
    });

    test("errors when multiple streams match the same repo and PR number", async () => {
      const streamA = newDriverStreamId();
      const streamB = newDriverStreamId();
      const runId = seedMultiStreamRun(store, [
        {
          id: streamA,
          prUrl: "https://github.com/org/ship/pull/62",
          status: "landed",
        },
        {
          id: streamB,
          prUrl: "https://github.com/org/ship/pull/62",
          status: "done",
        },
      ]);
      const gh = createFakeGhPort({
        62: {
          mergeCommit: { oid: "sha62" },
          mergedAt: "2026-06-12T07:00:00.000Z",
          state: "MERGED",
        },
      });

      await expect(land(store, gh, runId, { prNumber: 62 })).rejects.toThrow(
        /multiple landed streams match/,
      );
    });
  });
});

describe("toGhRepo", () => {
  test("extracts owner/repo from a full https URL", () => {
    expect(toGhRepo("https://github.com/itsHabib/ship")).toBe("itsHabib/ship");
  });
  test("strips a trailing .git", () => {
    expect(toGhRepo("https://github.com/itsHabib/ship.git")).toBe("itsHabib/ship");
  });
  test("handles an ssh remote", () => {
    expect(toGhRepo("git@github.com:itsHabib/ship.git")).toBe("itsHabib/ship");
  });
  test("passes through a short owner/repo unchanged", () => {
    expect(toGhRepo("itsHabib/ship")).toBe("itsHabib/ship");
  });
});

function seedMultiStreamRun(
  store: ReturnType<typeof createStore>,
  streams: { id: string; prUrl: string; status: "landed" | "done" }[],
): string {
  return store.insertDriverRun({
    batches: [
      {
        batchIndex: 1,
        dependsOn: [],
        id: newDriverBatchId(),
        status: "running",
        streams: streams.map((stream, streamIndex) => ({
          attempts: [],
          id: stream.id,
          prUrl: stream.prUrl,
          runtime: "cloud" as const,
          specPath: `${stream.id}.md`,
          status: stream.status,
          streamIndex,
          touches: [],
        })),
      },
    ],
    id: newDriverRunId(),
    manifestPath: "/tmp/driver.md",
    repo: "ship",
    sourceJson: minimalSource(),
    status: "running",
  }).id;
}

function seedLandedRun(
  store: ReturnType<typeof createStore>,
  streamId: string,
  opts: { prUrl?: string },
): string {
  return store.insertDriverRun({
    batches: [
      {
        batchIndex: 1,
        dependsOn: [],
        id: newDriverBatchId(),
        status: "running",
        streams: [
          {
            attempts: [],
            id: streamId,
            runtime: "cloud",
            specPath: "a.md",
            status: "landed",
            streamIndex: 0,
            touches: [],
            ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
          },
        ],
      },
    ],
    id: newDriverRunId(),
    manifestPath: "/tmp/driver.md",
    repo: "ship",
    sourceJson: minimalSource(),
    status: "running",
  }).id;
}

function seedDoneRun(
  store: ReturnType<typeof createStore>,
  streamId: string,
  prUrl: string,
): string {
  return store.insertDriverRun({
    batches: [
      {
        batchIndex: 1,
        dependsOn: [],
        id: newDriverBatchId(),
        status: "running",
        streams: [
          {
            attempts: [],
            id: streamId,
            prUrl,
            runtime: "cloud",
            specPath: "a.md",
            status: "done",
            streamIndex: 0,
            touches: [],
          },
        ],
      },
    ],
    id: newDriverRunId(),
    manifestPath: "/tmp/driver.md",
    repo: "ship",
    sourceJson: minimalSource(),
    status: "running",
  }).id;
}

function minimalSource(): string {
  return `---
driver_version: 1
generated_at: 2026-06-12T00:00:00Z
generated_by: test
source:
  project: ship
  phase: t
repo_url: https://github.com/org/ship
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: a.md
---
`;
}

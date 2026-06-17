/** Land verb — merge, read gh facts, record via markMerged. */

import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DecideError } from "./errors.js";
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
      prUrl: "https://github.com/org/repo/pull/42",
    });
    const gh = createFakeGhPort({
      42: { mergeCommit: null, mergedAt: null, state: "OPEN" },
    });

    const run = await land(store, gh, runId, { prNumber: 42 });
    const stream = run.batches[0]?.streams[0];

    expect(gh.mergeCalls).toHaveLength(1);
    expect(gh.mergeCalls[0]?.prNumber).toBe(42);
    expect(stream?.status).toBe("done");
    expect(stream?.prNumber).toBe(42);
    expect(stream?.mergeCommit).toBe("fake-merge-sha");
    expect(stream?.mergedAt).toBeDefined();
  });

  test("records an already-MERGED PR without re-merging", async () => {
    const streamId = newDriverStreamId();
    const runId = seedLandedRun(store, streamId, {
      prUrl: "https://github.com/org/repo/pull/7",
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
      prUrl: "https://github.com/org/repo/pull/99",
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

  test("errors when stream is not landed", async () => {
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
              prUrl: "https://github.com/org/repo/pull/11",
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

    await expect(land(store, gh, runId, { prNumber: 11, streamId })).rejects.toThrow(/not landed/);
  });
});

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

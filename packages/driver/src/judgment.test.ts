/** Judgment, decide, recovery table, and eligibility tests. */

import type { WorkflowRun } from "@ship/workflow";

import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CancelError, DecideError } from "./errors.js";
import {
  cancelRun,
  decide,
  type DispatchAmbiguity,
  isBatchEligible,
  isBlockedOnMerges,
  markMerged,
  recoverDispatchingStreams,
} from "./judgment.js";
import { createFakeShipPort } from "./test/fake-ship-port.js";

describe("judgment", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test("decide retry/skip/abort/adopt paths", () => {
    const runId = seedAwaitingRun(store);
    const streamId = store.getDriverRun(runId)!.batches[0]!.streams[0]!.id;

    decide(store, runId, streamId, { kind: "retry" });
    expect(store.getDriverRun(runId)?.status).toBe("running");
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.status).toBe("pending");

    store.updateDriverRunStatus(runId, "awaiting_judgment");
    store.updateDriverStream(streamId, { status: "failed" });
    decide(store, runId, streamId, { kind: "skip", reason: "not worth it" });
    expect(store.getDriverRun(runId)?.status).toBe("running");
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.status).toBe("skipped");

    store.updateDriverRunStatus(runId, "awaiting_judgment");
    store.updateDriverStream(streamId, { status: "failed" });
    decide(store, runId, streamId, { kind: "abort", reason: "stop" });
    expect(store.getDriverRun(runId)?.status).toBe("failed");
  });

  test("decide gating errors", () => {
    const runId = seedAwaitingRun(store);
    const streamId = store.getDriverRun(runId)!.batches[0]!.streams[0]!.id;
    store.updateDriverRunStatus(runId, "running");
    expect(() => decide(store, runId, streamId, { kind: "retry" })).toThrow(DecideError);
  });

  test("recovery: exactly-one candidate adopts", async () => {
    const runId = seedDispatchingRun(store, "/abs/docs/a.md");
    const streamId = store.getDriverRun(runId)!.batches[0]!.streams[0]!.id;
    const candidate: WorkflowRun = {
      baseRef: "main",
      createdAt: "2026-06-12T00:00:01.000Z",
      docPath: "/abs/docs/a.md",
      id: "wf_adopt",
      phases: [],
      policy: { agentTimeoutMs: 1_800_000, baseRef: "main", maxRunDurationMs: 1_800_000 },
      repo: "ship",
      status: "running",
      updatedAt: "2026-06-12T00:00:01.000Z",
      worktree: {
        baseRef: "main",
        branch: "feat-a",
        name: "feat-a",
        path: "/wt",
        repo: "ship",
      },
    };
    const { port } = createFakeShipPort([]);
    port.listRuns = () => Promise.resolve([candidate]);

    await recoverDispatchingStreams(store, port, store.getDriverRun(runId)!, []);
    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("dispatched");
    expect(stream?.workflowRunId).toBe("wf_adopt");
    expect(streamId).toBeDefined();
  });

  test("recovery: multiple candidates emit ambiguity", async () => {
    const runId = seedDispatchingRun(store, "/abs/docs/a.md");
    const ambiguities: DispatchAmbiguity[] = [];
    const { port } = createFakeShipPort([
      { branch: "feat-a", docPath: "/abs/docs/a.md", repo: "ship", workflowRunId: "wf_1" },
      { branch: "feat-a", docPath: "/abs/docs/a.md", repo: "ship", workflowRunId: "wf_2" },
    ]);
    await recoverDispatchingStreams(store, port, store.getDriverRun(runId)!, ambiguities);
    expect(ambiguities).toHaveLength(1);
    expect(ambiguities[0]?.candidates.length).toBeGreaterThan(1);
  });

  test("markMerged records merge facts on landed stream", () => {
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    const runId = store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batchId,
          status: "running",
          streams: [
            {
              attempts: [],
              id: streamId,
              runtime: "local",
              specPath: "a.md",
              status: "landed",
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

    markMerged(store, runId, streamId, {
      mergeCommit: "deadbeef",
      mergedAt: "2026-06-12T00:00:00.000Z",
      prNumber: 42,
    });
    const run = store.getDriverRun(runId);
    const stream = run?.batches[0]?.streams[0];
    expect(stream?.status).toBe("done");
    expect(stream?.prNumber).toBe(42);
    expect(run?.status).toBe("done");
    expect(run?.batches[0]?.status).toBe("done");
    expect(run?.batches[0]?.completedAt).toBeDefined();
  });

  test("cancelRun marks in-flight streams failed and run cancelled", async () => {
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
              runtime: "local",
              specPath: "a.md",
              status: "dispatched",
              streamIndex: 0,
              touches: [],
              workflowRunId: "wf_cancel_me",
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

    const { port } = createFakeShipPort([
      { docPath: "a.md", repo: "ship", terminalStatus: "running", workflowRunId: "wf_cancel_me" },
    ]);
    const cancelled = await cancelRun(store, port, runId, "2026-06-12T00:00:05.000Z");
    expect(cancelled.status).toBe("cancelled");
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.status).toBe("failed");
  });

  test("decide adopt on non-dispatching stream throws", () => {
    const runId = seedAwaitingRun(store);
    const streamId = store.getDriverRun(runId)!.batches[0]!.streams[0]!.id;
    expect(() => decide(store, runId, streamId, { kind: "adopt", workflowRunId: "wf_x" })).toThrow(
      DecideError,
    );
  });

  test("markMerged and cancelRun error paths", async () => {
    expect(() =>
      markMerged(store, "drv_missing", "ds_x", { mergeCommit: "a", prNumber: 1 }),
    ).toThrow(DecideError);

    await expect(
      cancelRun(store, createFakeShipPort([]).port, "drv_missing", "2026-06-12T00:00:05.000Z"),
    ).rejects.toThrow(CancelError);
  });

  test("recovery at list limit emits ambiguity", async () => {
    const runId = seedDispatchingRun(store, "/abs/docs/a.md");
    const ambiguities: DispatchAmbiguity[] = [];
    const runs = Array.from({ length: 200 }, (_, i) => ({
      baseRef: "main",
      createdAt: "2026-06-12T00:00:01.000Z",
      docPath: `/other/${String(i)}.md`,
      id: `wf_${String(i)}`,
      phases: [],
      policy: { agentTimeoutMs: 1, baseRef: "main", maxRunDurationMs: 1 },
      repo: "ship",
      status: "running" as const,
      updatedAt: "2026-06-12T00:00:01.000Z",
      worktree: {
        baseRef: "main",
        branch: "b",
        name: "b",
        path: "/wt",
        repo: "ship",
      },
    }));
    const { port } = createFakeShipPort([]);
    port.listRuns = () => Promise.resolve(runs);
    await recoverDispatchingStreams(store, port, store.getDriverRun(runId)!, ambiguities);
    expect(ambiguities).toHaveLength(1);
  });

  test("decide adopt answers dispatch-ambiguity", () => {
    const streamId = newDriverStreamId();
    const runId = store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: newDriverBatchId(),
          status: "pending",
          streams: [
            {
              attempts: [
                { dispatchedAt: "2026-06-12T00:00:00.000Z", docPath: "/x", terminal: false },
              ],
              id: streamId,
              runtime: "local",
              specPath: "a.md",
              status: "dispatching",
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
      status: "awaiting_judgment",
    }).id;

    decide(store, runId, streamId, { kind: "adopt", workflowRunId: "wf_picked" });
    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("dispatched");
    expect(stream?.workflowRunId).toBe("wf_picked");
  });

  test("two failed streams can both be decided without a re-tick", () => {
    const streamA = newDriverStreamId();
    const streamB = newDriverStreamId();
    const runId = store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: newDriverBatchId(),
          status: "pending",
          streams: [
            {
              attempts: [
                { dispatchedAt: "2026-06-12T00:00:00.000Z", terminal: true, workflowRunId: "wf_a" },
              ],
              id: streamA,
              runtime: "local",
              specPath: "a.md",
              status: "failed",
              streamIndex: 0,
              touches: [],
            },
            {
              attempts: [
                { dispatchedAt: "2026-06-12T00:00:00.000Z", terminal: true, workflowRunId: "wf_b" },
              ],
              id: streamB,
              runtime: "local",
              specPath: "b.md",
              status: "failed",
              streamIndex: 1,
              touches: [],
            },
          ],
        },
      ],
      id: newDriverRunId(),
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: minimalSource(),
      status: "awaiting_judgment",
    }).id;

    decide(store, runId, streamA, { kind: "skip", reason: "skip a" });
    expect(store.getDriverRun(runId)?.status).toBe("awaiting_judgment");

    decide(store, runId, streamB, { kind: "retry" });
    expect(store.getDriverRun(runId)?.status).toBe("running");
  });

  test("mark-merged on non-final stream leaves run running and later batch pending", () => {
    const batch1Id = newDriverBatchId();
    const batch2Id = newDriverBatchId();
    const stream1Id = newDriverStreamId();
    const stream2Id = newDriverStreamId();
    const runId = store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batch1Id,
          status: "running",
          streams: [
            {
              attempts: [],
              id: stream1Id,
              runtime: "local",
              specPath: "a.md",
              status: "landed",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
        {
          batchIndex: 2,
          dependsOn: [1],
          id: batch2Id,
          status: "pending",
          streams: [
            {
              attempts: [],
              id: stream2Id,
              runtime: "local",
              specPath: "b.md",
              status: "pending",
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

    markMerged(store, runId, stream1Id, { mergeCommit: "abc", prNumber: 1 });
    const run = store.getDriverRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.batches[0]?.status).toBe("done");
    expect(run?.batches[1]?.status).toBe("pending");
  });

  test("final mark-merged flips run to done and rolls every batch to done", () => {
    const batch1Id = newDriverBatchId();
    const batch2Id = newDriverBatchId();
    const stream1Id = newDriverStreamId();
    const stream2Id = newDriverStreamId();
    const runId = store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batch1Id,
          status: "pending",
          streams: [
            {
              attempts: [],
              id: stream1Id,
              mergeCommit: "abc",
              prNumber: 1,
              runtime: "local",
              specPath: "a.md",
              status: "done",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
        {
          batchIndex: 2,
          dependsOn: [1],
          id: batch2Id,
          status: "pending",
          streams: [
            {
              attempts: [],
              id: stream2Id,
              runtime: "local",
              specPath: "b.md",
              status: "landed",
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

    markMerged(store, runId, stream2Id, { mergeCommit: "def", prNumber: 2 });
    const run = store.getDriverRun(runId);
    expect(run?.status).toBe("done");
    expect(run?.batches.every((b) => b.status === "done")).toBe(true);
    expect(run?.batches.every((b) => b.completedAt !== undefined)).toBe(true);
  });

  test("§7.6 isBatchEligible and blocked_on_merges", () => {
    const run = store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: newDriverBatchId(),
          status: "running",
          streams: [
            {
              attempts: [],
              id: newDriverStreamId(),
              runtime: "local",
              specPath: "a.md",
              status: "landed",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
        {
          batchIndex: 2,
          dependsOn: [1],
          id: newDriverBatchId(),
          status: "pending",
          streams: [
            {
              attempts: [],
              id: newDriverStreamId(),
              runtime: "local",
              specPath: "b.md",
              status: "pending",
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
    });

    expect(isBatchEligible(run.batches[1]!, run.batches)).toBe(false);
    expect(isBlockedOnMerges(run)).toBe(true);
  });
});

function seedAwaitingRun(store: ReturnType<typeof createStore>): string {
  const runId = newDriverRunId();
  const streamId = newDriverStreamId();
  store.insertDriverRun({
    batches: [
      {
        batchIndex: 1,
        dependsOn: [],
        id: newDriverBatchId(),
        status: "pending",
        streams: [
          {
            attempts: [
              { dispatchedAt: "2026-06-12T00:00:00.000Z", terminal: true, workflowRunId: "wf_x" },
            ],
            id: streamId,
            runtime: "local",
            specPath: "a.md",
            status: "failed",
            streamIndex: 0,
            touches: [],
            workflowRunId: "wf_x",
          },
        ],
      },
    ],
    id: runId,
    manifestPath: "/tmp/driver.md",
    repo: "ship",
    sourceJson: minimalSource(),
    status: "awaiting_judgment",
  });
  return runId;
}

function seedDispatchingRun(store: ReturnType<typeof createStore>, docPath: string): string {
  const runId = newDriverRunId();
  store.insertDriverRun({
    batches: [
      {
        batchIndex: 1,
        dependsOn: [],
        id: newDriverBatchId(),
        status: "pending",
        streams: [
          {
            attempts: [{ dispatchedAt: "2026-06-12T00:00:00.000Z", docPath, terminal: false }],
            branch: "feat-a",
            id: newDriverStreamId(),
            runtime: "local",
            specPath: "docs/a.md",
            status: "dispatching",
            streamIndex: 0,
            touches: [],
          },
        ],
      },
    ],
    id: runId,
    manifestPath: "/tmp/driver.md",
    repo: "ship",
    sourceJson: minimalSource(),
    status: "running",
  });
  return runId;
}

function minimalSource(): string {
  return `---
driver_version: 1
generated_at: 2026-06-12T00:00:00Z
generated_by: test
source:
  project: ship
  phase: t
repo: ship
batches: []
---
`;
}

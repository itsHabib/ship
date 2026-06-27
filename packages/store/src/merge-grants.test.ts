/** Tests for merge-grant store ops. */

import {
  createStore,
  newDriverBatchId,
  newDriverRunId,
  newDriverStreamId,
  normalizeMergeGrantRepo,
} from "@ship/store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

describe("merge grants", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore({ clock: () => "2026-06-27T00:00:00.000Z", dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test("registerMergeGrant is idempotent for the same repo", () => {
    const first = store.registerMergeGrant({ repo: "https://github.com/org/ship" });
    const second = store.registerMergeGrant({ repo: "org/ship" });

    expect(second.id).toBe(first.id);
    expect(normalizeMergeGrantRepo("https://github.com/org/ship")).toBe("org/ship");
  });

  test("getActiveMergeGrant returns null before registration", () => {
    expect(store.getActiveMergeGrant("org/ship")).toBeNull();
  });

  test("recordMergeGrantSatisfaction writes an auditable row", () => {
    const grant = store.registerMergeGrant({ repo: "org/ship" });
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
              prUrl: "https://github.com/org/ship/pull/42",
              runtime: "cloud",
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

    const verdictJson = JSON.stringify({ outcome: "merge_authorized" });
    const row = store.recordMergeGrantSatisfaction({
      driverRunId: runId,
      driverStreamId: streamId,
      grantId: grant.id,
      mergeCommit: "abc123",
      prNumber: 42,
      verdictJson,
    });

    expect(row.grantId).toBe(grant.id);
    expect(row.verdictJson).toBe(verdictJson);
    expect(store.listMergeGrantSatisfactionsByStream(streamId)).toEqual([row]);
  });
});

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

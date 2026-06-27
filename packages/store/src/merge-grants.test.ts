/** Merge-grant store persistence. */

import { createStore } from "@ship/store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

describe("merge grants", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore({ clock: () => "2026-06-27T00:00:00.000Z", dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test("registerRepoMergeGrant persists an active grant for owner/repo", () => {
    const grant = store.registerRepoMergeGrant("https://github.com/org/ship");

    expect(grant.repo).toBe("org/ship");
    expect(grant.grantedAt).toBe("2026-06-27T00:00:00.000Z");
    expect(grant.revokedAt).toBeUndefined();
    expect(store.getActiveRepoMergeGrant("org/ship")).toEqual(grant);
  });

  test("re-registering revokes the prior grant and replaces it", () => {
    const first = store.registerRepoMergeGrant("org/ship");
    const second = store.registerRepoMergeGrant("org/ship");

    expect(second.id).not.toBe(first.id);
    expect(store.getActiveRepoMergeGrant("org/ship")?.id).toBe(second.id);
  });

  test("recordMergeGrantSatisfaction writes a per-PR audit row", () => {
    const grant = store.registerRepoMergeGrant("org/ship");
    const satisfaction = store.recordMergeGrantSatisfaction({
      driverRunId: "drv_test",
      driverStreamId: "ds_test",
      grantId: grant.id,
      mergeCommit: "abc123",
      prNumber: 42,
      repo: "org/ship",
      verdictJson: '{"outcome":"merge_authorized"}',
    });

    expect(satisfaction.grantId).toBe(grant.id);
    expect(satisfaction.prNumber).toBe(42);
    expect(satisfaction.mergeCommit).toBe("abc123");
    expect(store.getMergeGrantSatisfaction("org/ship", 42)).toEqual(satisfaction);
  });
});

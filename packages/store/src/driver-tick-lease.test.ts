/** Tick lease store verb tests. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createStore } from "./store.js";

describe("driver tick lease verbs", () => {
  let store: ReturnType<typeof createStore>;
  let now: string;

  beforeEach(() => {
    now = "2026-06-12T00:00:00.000Z";
    store = createStore({ clock: () => now, dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test("stampDriverRunTickStarted and stampDriverRunTickEnded bump updated_at", () => {
    const run = store.insertDriverRun({
      batches: [],
      id: "drv_test",
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    now = "2026-06-12T00:01:00.000Z";
    const started = store.stampDriverRunTickStarted(run.id);
    expect(started.tickStartedAt).toBe("2026-06-12T00:01:00.000Z");
    expect(started.updatedAt).toBe("2026-06-12T00:01:00.000Z");

    now = "2026-06-12T00:02:00.000Z";
    const ended = store.stampDriverRunTickEnded(run.id);
    expect(ended.tickEndedAt).toBe("2026-06-12T00:02:00.000Z");
    expect(ended.updatedAt).toBe("2026-06-12T00:02:00.000Z");
  });

  test("claimDriverRunTick is an atomic check-and-stamp", () => {
    const run = store.insertDriverRun({
      batches: [],
      id: "drv_claim",
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    // First claim wins; a second claim against the live, fresh tick refuses.
    expect(store.claimDriverRunTick(run.id, { force: false, staleBefore: now })).toBe(true);
    expect(store.claimDriverRunTick(run.id, { force: false, staleBefore: now })).toBe(false);

    // Force takes over regardless of liveness.
    expect(store.claimDriverRunTick(run.id, { force: true, staleBefore: now })).toBe(true);

    // A cleanly-ended tick never blocks the next claim.
    now = "2026-06-12T00:03:00.000Z";
    store.stampDriverRunTickEnded(run.id);
    expect(
      store.claimDriverRunTick(run.id, { force: false, staleBefore: "2026-06-12T00:00:00.000Z" }),
    ).toBe(true);

    // A stale unended tick (updated_at older than staleBefore) is taken over.
    expect(
      store.claimDriverRunTick(run.id, { force: false, staleBefore: "2026-06-13T00:00:00.000Z" }),
    ).toBe(true);
  });
});

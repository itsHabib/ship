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
});

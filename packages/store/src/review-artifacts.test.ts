import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { ConsumeReviewArtifactInput, Store } from "./index.js";

import {
  createStore,
  newDriverBatchId,
  newDriverRunId,
  newDriverStreamId,
  ReviewArtifactAddressRacedError,
  ReviewArtifactDuplicateError,
} from "./index.js";

describe("review artifact consumption", () => {
  const stores: Store[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  function open(dbPath = ":memory:"): Store {
    const store = createStore({ clock: () => "2026-07-10T00:00:00Z", dbPath });
    stores.push(store);
    return store;
  }

  function seed(store: Store): { input: ConsumeReviewArtifactInput; streamId: string } {
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batchId,
          status: "running",
          streams: [
            {
              attempts: [],
              branch: "feature/review",
              id: streamId,
              prUrl: "https://github.com/example/ship/pull/1",
              runtime: "cloud",
              specPath: "docs/a.md",
              status: "landed",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath: "C:/repo/driver.md",
      repo: "ship",
      sourceJson: "source",
      status: "running",
    });
    return {
      input: {
        addressCycle: 1,
        artifactId: "rf_one",
        attempts: [
          {
            dispatchedAt: "2026-07-10T00:00:00Z",
            docPath: "C:/repo/address.md",
            terminal: false,
          },
        ],
        canonicalSha256: "a".repeat(64),
        dispatchProvider: "cursor",
        docPath: "C:/repo/address.md",
        driverRunId: runId,
        expectedReviewCycle: 0,
        headSha: "b".repeat(40),
        prNumber: 1,
        repo: "example/ship",
        streamId,
      },
      streamId,
    };
  }

  test("atomically consumes and prepares exactly one dispatch", () => {
    const store = open();
    const { input, streamId } = seed(store);

    store.consumeReviewArtifactAndPrepareDispatch(input);

    const stream = store.getDriverRun(input.driverRunId)?.batches[0]?.streams[0];
    expect(stream).toMatchObject({
      attempts: input.attempts,
      reviewCycles: 1,
      status: "dispatching",
      workOnCurrentBranch: true,
    });
    expect(() => {
      store.consumeReviewArtifactAndPrepareDispatch(input);
    }).toThrow(ReviewArtifactDuplicateError);
    expect(stream?.id).toBe(streamId);
  });

  test("cycle compare-and-swap rolls the artifact insert back", () => {
    const store = open();
    const { input } = seed(store);
    store.updateDriverStream(input.streamId, { reviewCycles: 1 });

    expect(() => {
      store.consumeReviewArtifactAndPrepareDispatch(input);
    }).toThrow(ReviewArtifactAddressRacedError);

    store.updateDriverStream(input.streamId, { reviewCycles: 0 });
    expect(() => {
      store.consumeReviewArtifactAndPrepareDispatch(input);
    }).not.toThrow();
  });

  test("a real SQLite abort trigger rolls back both artifact and stream writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-review-artifact-"));
    dirs.push(dir);
    const dbPath = join(dir, "state.db");
    const store = open(dbPath);
    const { input } = seed(store);
    const db = new Database(dbPath);
    db.exec(`CREATE TRIGGER abort_address BEFORE UPDATE ON driver_streams
      WHEN NEW.status = 'dispatching' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`);
    db.close();

    expect(() => {
      store.consumeReviewArtifactAndPrepareDispatch(input);
    }).toThrow(/forced rollback/u);
    expect(store.getDriverRun(input.driverRunId)?.batches[0]?.streams[0]).toMatchObject({
      attempts: [],
      status: "landed",
    });

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const inspect = new Database(dbPath);
    const count = inspect
      .prepare("SELECT COUNT(*) AS count FROM driver_review_artifacts")
      .get() as {
      count: number;
    };
    inspect.close();
    expect(count.count).toBe(0);
  });
});

/** Tests for driver run store verbs via `createStore`. */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { FallbackLogRecord } from "./driver-schemas.js";
import type { Store } from "./store.js";

import { newDriverBatchId, newDriverRunId, newDriverStreamId } from "./driver-ids.js";
import {
  DriverBatchNotFoundError,
  DriverRunNotFoundError,
  DriverStreamNotFoundError,
  StoreSchemaError,
} from "./errors.js";
import { runMigrations } from "./migrations.js";
import { createStore } from "./store.js";

describe("driver runs (via createStore)", () => {
  let store: Store;
  let currentNow: string;

  beforeEach(() => {
    currentNow = "2026-06-10T00:00:00.000Z";
    store = createStore({ clock: () => currentNow, dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  function seedRun(): string {
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batchId,
          status: "pending",
          streams: [
            {
              attempts: [],
              id: streamId,
              runtime: "local",
              specPath: "docs/a.md",
              status: "pending",
              streamIndex: 0,
              touches: ["src/a.ts"],
            },
          ],
        },
      ],
      id: runId,
      manifestPath: "/tmp/driver.md",
      phase: "test-phase",
      project: "ship",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });
    return runId;
  }

  // Single accessor for the seeded run's first stream — keeps assertion bodies
  // off a long optional-chain (each `?.` counts against complexity).
  function firstStreamOf(
    runId: string,
  ):
    | NonNullable<ReturnType<Store["getDriverRun"]>>["batches"][number]["streams"][number]
    | undefined {
    return store.getDriverRun(runId)?.batches[0]?.streams[0];
  }

  test("insertDriverRun + getDriverRun returns hydrated aggregate", () => {
    const runId = seedRun();
    const run = store.getDriverRun(runId);
    expect(run?.id).toBe(runId);
    expect(run?.batches).toHaveLength(1);
    expect(run?.batches[0]?.streams).toHaveLength(1);
    expect(run?.batches[0]?.streams[0]?.specPath).toBe("docs/a.md");
  });

  test("getDriverRun for unknown id returns null", () => {
    expect(store.getDriverRun(newDriverRunId())).toBeNull();
  });

  test("updateDriverRunStatus bumps updated_at", () => {
    const runId = seedRun();
    currentNow = "2026-06-10T01:00:00.000Z";
    const updated = store.updateDriverRunStatus(runId, "running");
    expect(updated.status).toBe("running");
    expect(updated.updatedAt).toBe("2026-06-10T01:00:00.000Z");
  });

  test("updateDriverRunStatus throws DriverRunNotFoundError for unknown id", () => {
    expect(() => store.updateDriverRunStatus(newDriverRunId(), "running")).toThrow(
      DriverRunNotFoundError,
    );
  });

  test("updateDriverBatch bumps parent updated_at", () => {
    const runId = seedRun();
    const batchId = store.getDriverRun(runId)?.batches[0]?.id;
    expect(batchId).toBeDefined();
    currentNow = "2026-06-10T02:00:00.000Z";
    store.updateDriverBatch(batchId!, { completedAt: "2026-06-10T02:00:00.000Z", status: "done" });
    const run = store.getDriverRun(runId);
    expect(run?.updatedAt).toBe("2026-06-10T02:00:00.000Z");
    expect(run?.batches[0]?.status).toBe("done");
  });

  test("updateDriverBatch throws DriverBatchNotFoundError for unknown id", () => {
    expect(() => store.updateDriverBatch(newDriverBatchId(), { status: "done" })).toThrow(
      DriverBatchNotFoundError,
    );
  });

  test("updateDriverStream bumps parent updated_at", () => {
    const runId = seedRun();
    const streamId = store.getDriverRun(runId)?.batches[0]?.streams[0]?.id;
    expect(streamId).toBeDefined();
    currentNow = "2026-06-10T03:00:00.000Z";
    store.updateDriverStream(streamId!, { prNumber: 42, status: "done" });
    const run = store.getDriverRun(runId);
    expect(run?.updatedAt).toBe("2026-06-10T03:00:00.000Z");
    expect(run?.batches[0]?.streams[0]?.prNumber).toBe(42);
  });

  test("reviewCycles defaults undefined and round-trips through update", () => {
    const runId = seedRun();
    const streamId = firstStreamOf(runId)?.id;
    expect(streamId).toBeDefined();
    // Existing rows carry no review-cycle count until `address` sets one.
    expect(firstStreamOf(runId)?.reviewCycles).toBeUndefined();

    store.updateDriverStream(streamId!, { reviewCycles: 1 });
    expect(firstStreamOf(runId)?.reviewCycles).toBe(1);

    store.updateDriverStream(streamId!, { reviewCycles: 2 });
    expect(firstStreamOf(runId)?.reviewCycles).toBe(2);
  });

  function seedRunWithStream(
    stream: Parameters<Store["insertDriverRun"]>[0]["batches"][number]["streams"][number],
  ): string {
    const runId = newDriverRunId();
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: newDriverBatchId(),
          status: "pending",
          streams: [stream],
        },
      ],
      id: runId,
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });
    return runId;
  }

  test("fallback chain, cursor, empty log, and reviewCycles round-trip on insert", () => {
    const runId = seedRunWithStream({
      attempts: [],
      fallbackChain: [
        { provider: "claude", runtime: "cloud", modelId: "opus" },
        { provider: "claude", runtime: "local" },
      ],
      fallbackCursor: 0,
      fallbackLog: [],
      id: newDriverStreamId(),
      reviewCycles: 0,
      runtime: "cloud",
      specPath: "docs/a.md",
      status: "pending",
      streamIndex: 0,
      touches: [],
    });

    const stream = firstStreamOf(runId);
    expect(stream?.fallbackChain).toEqual([
      { provider: "claude", runtime: "cloud", modelId: "opus" },
      { provider: "claude", runtime: "local" },
    ]);
    expect(stream?.fallbackCursor).toBe(0);
    expect(stream?.fallbackLog).toEqual([]);
    expect(stream?.reviewCycles).toBe(0);
  });

  test("populated fallback log (hop, skip, retry) round-trips through the union schema", () => {
    const log: FallbackLogRecord[] = [
      {
        from: { provider: "cursor", runtime: "cloud" },
        to: { provider: "claude", runtime: "local" },
        category: "gateway-auth",
        at: "2026-07-13T00:00:00.000Z",
      },
      {
        skipped: { provider: "claude", runtime: "cloud" },
        reason: "ANTHROPIC_API_KEY not set",
        at: "2026-07-13T00:01:00.000Z",
      },
      {
        retried: { provider: "cursor", runtime: "cloud" },
        reason: "sdk-throw",
        at: "2026-07-13T00:02:00.000Z",
      },
    ];
    const runId = seedRunWithStream({
      attempts: [],
      fallbackChain: [{ provider: "claude", runtime: "local" }],
      fallbackCursor: 1,
      fallbackLog: log,
      id: newDriverStreamId(),
      runtime: "local",
      specPath: "docs/a.md",
      status: "pending",
      streamIndex: 0,
      touches: [],
    });

    expect(firstStreamOf(runId)?.fallbackLog).toEqual(log);
    expect(firstStreamOf(runId)?.fallbackCursor).toBe(1);
  });

  test("streams with no chain read the fallback columns back as absent", () => {
    const stream = firstStreamOf(seedRun());
    expect(stream?.fallbackChain).toBeUndefined();
    expect(stream?.fallbackCursor).toBeUndefined();
    expect(stream?.fallbackLog).toBeUndefined();
  });

  test("provider column round-trips through insert and read", () => {
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batchId,
          status: "pending",
          streams: [
            {
              attempts: [],
              id: streamId,
              provider: "claude",
              runtime: "cloud",
              specPath: "docs/a.md",
              status: "pending",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath: "/tmp/provider.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.provider).toBe("claude");
  });

  test("model_id column round-trips through insert and read", () => {
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batchId,
          status: "pending",
          streams: [
            {
              attempts: [],
              id: streamId,
              modelId: "grok-4.5",
              provider: "cursor",
              runtime: "cloud",
              specPath: "docs/a.md",
              status: "pending",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath: "/tmp/modelid.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.modelId).toBe("grok-4.5");
  });

  test("model_id absent stays undefined on the hydrated stream", () => {
    const runId = seedRun();
    expect(firstStreamOf(runId)?.modelId).toBeUndefined();
  });

  test("updateDriverStream throws DriverStreamNotFoundError for unknown id", () => {
    expect(() => store.updateDriverStream(newDriverStreamId(), { status: "failed" })).toThrow(
      DriverStreamNotFoundError,
    );
  });

  test("deleteDriverRun removes the run and cascades its batches + streams", () => {
    const runId = seedRun();
    const seeded = store.getDriverRun(runId);
    const batchId = seeded?.batches[0]?.id;
    const streamId = seeded?.batches[0]?.streams[0]?.id;
    expect(batchId).toBeDefined();
    expect(streamId).toBeDefined();

    expect(store.deleteDriverRun(runId)).toBe(true);
    expect(store.getDriverRun(runId)).toBeNull();
    // Children cascaded: their update paths now report the rows gone.
    expect(() => store.updateDriverBatch(batchId!, { status: "done" })).toThrow(
      DriverBatchNotFoundError,
    );
    expect(() => store.updateDriverStream(streamId!, { status: "failed" })).toThrow(
      DriverStreamNotFoundError,
    );
  });

  test("deleteDriverRun returns false for an unknown id", () => {
    expect(store.deleteDriverRun(newDriverRunId())).toBe(false);
  });

  test("listDriverRuns filters by repo and status", () => {
    const runId = seedRun();
    store.updateDriverRunStatus(runId, "done");
    const otherId = newDriverRunId();
    store.insertDriverRun({
      batches: [],
      id: otherId,
      manifestPath: "/tmp/other.md",
      repo: "other-repo",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const filtered = store.listDriverRuns({ repo: "ship", status: ["done"] });
    expect(filtered.map((run) => run.id)).toEqual([runId]);
  });

  test("listDriverRuns filters by project and phase", () => {
    const runId = seedRun();
    store.insertDriverRun({
      batches: [],
      id: newDriverRunId(),
      manifestPath: "/tmp/other-phase.md",
      phase: "other-phase",
      project: "ship",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const filtered = store.listDriverRuns({ phase: "test-phase", project: "ship", repo: "ship" });
    expect(filtered.map((run) => run.id)).toEqual([runId]);
  });

  test("listDriverRuns does not mutate hydrated rows", () => {
    const runId = seedRun();
    const beforeUpdated = store.getDriverRun(runId)?.updatedAt;
    const beforeStatus = store.getDriverRun(runId)?.status;
    store.listDriverRuns({});
    const after = store.getDriverRun(runId);
    expect(after?.updatedAt).toBe(beforeUpdated);
    expect(after?.status).toBe(beforeStatus);
  });

  test("hydrated streams preserve manifest order via stream_index", () => {
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const specs = ["docs/z.md", "docs/a.md", "docs/m.md"];
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batchId,
          status: "pending",
          streams: specs.map((specPath, index) => ({
            attempts: [],
            id: newDriverStreamId(),
            runtime: "local",
            specPath,
            status: "pending",
            streamIndex: index,
            touches: [],
          })),
        },
      ],
      id: runId,
      manifestPath: "/tmp/ordered.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const run = store.getDriverRun(runId);
    expect(run?.batches[0]?.streams.map((stream) => stream.specPath)).toEqual(specs);
    expect(run?.batches[0]?.streams.map((stream) => stream.streamIndex)).toEqual([0, 1, 2]);
  });

  test("0005 applies on top of 0004 database file", () => {
    store.close();
    const dir = mkdtempSync(join(tmpdir(), "ship-driver-migrate-"));
    const dbPath = join(dir, "state.db");
    try {
      const legacy = createStore({ dbPath });
      legacy.close();

      const upgraded = createStore({ dbPath });
      const tables = upgraded.listDriverRuns({ limit: 1 }).map(() => true);
      expect(tables).toEqual([]);
      upgraded.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("reviewCycles survives a store close and reopen", () => {
    store.close();
    const dir = mkdtempSync(join(tmpdir(), "ship-driver-review-cycles-"));
    const dbPath = join(dir, "state.db");
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    try {
      const first = createStore({ clock: () => currentNow, dbPath });
      first.insertDriverRun({
        batches: [
          {
            batchIndex: 1,
            dependsOn: [],
            id: batchId,
            status: "pending",
            streams: [
              {
                attempts: [],
                id: streamId,
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
        manifestPath: "/tmp/driver.md",
        repo: "ship",
        sourceJson: "---\ndriver_version: 1\n---\n",
        status: "running",
      });
      first.updateDriverStream(streamId, { reviewCycles: 3 });
      first.close();

      const reopened = createStore({ clock: () => currentNow, dbPath });
      expect(reopened.getDriverRun(runId)?.batches[0]?.streams[0]?.reviewCycles).toBe(3);
      reopened.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("composite FK rejects stream referencing batch from different run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-driver-fk-"));
    const dbPath = join(dir, "fk.db");
    const runA = newDriverRunId();
    const runB = newDriverRunId();
    const batchA = newDriverBatchId();
    const batchB = newDriverBatchId();
    const streamB = newDriverStreamId();

    try {
      const seeded = createStore({ clock: () => currentNow, dbPath });
      seeded.insertDriverRun({
        batches: [{ batchIndex: 1, dependsOn: [], id: batchA, status: "pending", streams: [] }],
        id: runA,
        manifestPath: "/tmp/a.md",
        repo: "ship",
        sourceJson: "---\n---\n",
        status: "pending",
      });
      seeded.insertDriverRun({
        batches: [{ batchIndex: 1, dependsOn: [], id: batchB, status: "pending", streams: [] }],
        id: runB,
        manifestPath: "/tmp/b.md",
        repo: "ship",
        sourceJson: "---\n---\n",
        status: "pending",
      });
      seeded.close();

      const db = new Database(dbPath);
      db.pragma("foreign_keys = ON");

      expect(() => {
        db.prepare(
          `INSERT INTO driver_streams (
             id, driver_run_id, driver_batch_id, stream_index, spec_path, runtime, touches,
             status, attempts, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          streamB,
          runB,
          batchA,
          0,
          "docs/x.md",
          "local",
          "[]",
          "pending",
          "[]",
          currentNow,
          currentNow,
        );
      }).toThrow();
      db.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("updateDriverBatch rolls back the write when hydration fails", () => {
    store.close();
    const dir = mkdtempSync(join(tmpdir(), "ship-driver-rollback-"));
    const dbPath = join(dir, "rollback.db");
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();

    try {
      const seeded = createStore({ clock: () => currentNow, dbPath });
      seeded.insertDriverRun({
        batches: [
          {
            batchIndex: 1,
            dependsOn: [],
            id: batchId,
            status: "pending",
            streams: [
              {
                attempts: [],
                id: streamId,
                runtime: "local",
                specPath: "docs/a.md",
                status: "pending",
                streamIndex: 0,
                touches: [],
              },
            ],
          },
        ],
        id: newDriverRunId(),
        manifestPath: "/tmp/rollback.md",
        repo: "ship",
        sourceJson: "---\ndriver_version: 1\n---\n",
        status: "pending",
      });
      seeded.close();

      const raw = new Database(dbPath);
      raw.prepare("UPDATE driver_streams SET touches = 'not-json' WHERE id = ?").run(streamId);
      raw.close();

      const reopened = createStore({ clock: () => currentNow, dbPath });
      expect(() => reopened.updateDriverBatch(batchId, { status: "done" })).toThrow(
        StoreSchemaError,
      );
      reopened.close();

      const verify = new Database(dbPath);
      const row = verify.prepare("SELECT status FROM driver_batches WHERE id = ?").get(batchId) as {
        status: string;
      };
      verify.close();
      expect(row.status).toBe("pending");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("driver runs hydration failure", () => {
  test("invalid driver_runs status throws StoreSchemaError on read", () => {
    const currentNow = "2026-06-10T00:00:00.000Z";
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const runId = newDriverRunId();
    db.prepare(
      `INSERT INTO driver_runs (id, manifest_path, repo, status, source_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, "/tmp/x.md", "ship", "bogus-status", "{}", currentNow, currentNow);

    const dir = mkdtempSync(join(tmpdir(), "ship-driver-bad-"));
    const dbPath = join(dir, "bad.db");
    db.close();
    const fileDb = new Database(dbPath);
    fileDb.pragma("foreign_keys = ON");
    runMigrations(fileDb);
    fileDb
      .prepare(
        `INSERT INTO driver_runs (id, manifest_path, repo, status, source_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, "/tmp/x.md", "ship", "bogus-status", "{}", currentNow, currentNow);
    fileDb.close();

    const store = createStore({ clock: () => currentNow, dbPath });
    expect(() => store.getDriverRun(runId)).toThrow(StoreSchemaError);
    store.close();
    rmSync(dir, { force: true, recursive: true });
  });
});

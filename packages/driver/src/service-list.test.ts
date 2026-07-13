/** Service list-view coverage — filtering, ordering, cross-process read, no mutation. */

import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DriverListRunView } from "./list-view.js";

import { createDriverService } from "./service.js";
import { createFakeShipPort } from "./test/fake-ship-port.js";

describe("driver service listDriverRunsView", () => {
  let tmpDir: string;

  function seedRichRun(store: ReturnType<typeof createStore>): string {
    const runId = newDriverRunId();
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: newDriverBatchId(),
          label: "batch-a",
          status: "running",
          streams: [
            {
              attempts: [],
              id: newDriverStreamId(),
              modelTier: "sonnet",
              provider: "cursor",
              runtime: "local",
              specPath: "docs/task.md",
              status: "pending",
              streamIndex: 0,
              taskSlug: "task-a",
              touches: ["src/a.ts"],
            },
          ],
        },
      ],
      id: runId,
      manifestPath: "/tmp/driver.md",
      phase: "phase-a",
      project: "ship",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "running",
    });
    return runId;
  }

  function expectNestedFacts(run: DriverListRunView | undefined): void {
    expect(run?.project).toBe("ship");
    expect(run?.phase).toBe("phase-a");
    const batch = run?.batches[0];
    expect(batch?.label).toBe("batch-a");
    const stream = batch?.streams[0];
    expect(stream?.taskSlug).toBe("task-a");
    expect(stream?.specPath).toBe("docs/task.md");
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "driver-service-list-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("returns empty envelope for an empty store", () => {
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    expect(driver.listDriverRunsView()).toEqual({ runs: [], v: 1 });
    store.close();
  });

  test("filters by repo, status, and limit", () => {
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const doneId = newDriverRunId();
    const pendingId = newDriverRunId();
    const otherRepoId = newDriverRunId();

    for (const [id, repo, status] of [
      [doneId, "ship", "done"],
      [pendingId, "ship", "pending"],
      [otherRepoId, "other", "done"],
    ] as const) {
      store.insertDriverRun({
        batches: [],
        id,
        manifestPath: `/tmp/${id}.md`,
        repo,
        sourceJson: "---\ndriver_version: 1\n---\n",
        status,
      });
    }

    const filtered = driver.listDriverRunsView({ repo: "ship", status: ["done"], limit: 10 });
    expect(filtered.runs.map((run) => run.driverRunId)).toEqual([doneId]);
    store.close();
  });

  test("orders by createdAt desc", () => {
    let currentNow = "2026-06-10T00:00:00.000Z";
    const store = createStore({ clock: () => currentNow, dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });

    const olderId = newDriverRunId();
    store.insertDriverRun({
      batches: [],
      id: olderId,
      manifestPath: "/tmp/older.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    currentNow = "2026-06-10T01:00:00.000Z";
    const newerId = newDriverRunId();
    store.insertDriverRun({
      batches: [],
      id: newerId,
      manifestPath: "/tmp/newer.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const ids = driver.listDriverRunsView().runs.map((run) => run.driverRunId);
    expect(ids).toEqual([newerId, olderId]);
    store.close();
  });

  test("orders by id desc when createdAt ties", () => {
    const currentNow = "2026-06-10T01:00:00.000Z";
    const store = createStore({ clock: () => currentNow, dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });

    const firstId = newDriverRunId();
    store.insertDriverRun({
      batches: [],
      id: firstId,
      manifestPath: "/tmp/first.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const secondId = newDriverRunId();
    store.insertDriverRun({
      batches: [],
      id: secondId,
      manifestPath: "/tmp/second.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const ids = driver.listDriverRunsView().runs.map((run) => run.driverRunId);
    const [highId, lowId] = firstId > secondId ? [firstId, secondId] : [secondId, firstId];
    expect(ids).toEqual([highId, lowId]);
    store.close();
  });

  test("projects nested batch and stream facts", () => {
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    seedRichRun(store);

    const run = driver.listDriverRunsView().runs[0];
    expectNestedFacts(run);
    store.close();
  });

  test("listDriverRunsView does not trigger orphan resume", () => {
    const store = createStore({ dbPath: ":memory:" });
    const { port, calls } = createFakeShipPort([]);
    const driver = createDriverService({ ship: port, store });
    driver.listDriverRunsView();
    expect(calls).toEqual([]);
    store.close();
  });

  test("cross-process read sees durable imported state", () => {
    const dbPath = join(tmpDir, "cross-process.db");
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "task.md"), "# task\n");
    const manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T10:00:00.000Z
generated_by: test
source:
  project: ship
  phase: service-list
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/task.md
        branch_name: feat-a
        runtime: local
        status: pending
---
`,
    );

    const writer = createStore({ dbPath });
    const writerDriver = createDriverService({ ship: createFakeShipPort([]).port, store: writer });
    const imported = writerDriver.importManifest(manifestPath);
    writer.close();

    const reader = createStore({ dbPath });
    const readerDriver = createDriverService({ ship: createFakeShipPort([]).port, store: reader });
    const envelope = readerDriver.listDriverRunsView();
    reader.close();

    expect(envelope.runs).toHaveLength(1);
    expect(envelope.runs[0]?.driverRunId).toBe(imported.run.id);
    expect(envelope.runs[0]?.batches[0]?.streams[0]?.specPath).toBe("docs/task.md");
  });
});

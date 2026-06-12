/** Engine tick loop tests — fake clock, fake port, in-memory store. */

import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DriverStreamView } from "./types.js";

import { isTickLive, resolveDocPath, resolveRepoRoot } from "./engine.js";
import { TickLiveError } from "./errors.js";
import { type DispatchAmbiguity, recoverDispatchingStreams } from "./judgment.js";
import { createDriverService } from "./service.js";
import { createFakeShipPort } from "./test/fake-ship-port.js";

describe("driver engine", () => {
  let tmpDir: string;
  let repoRoot: string;
  let manifestPath: string;
  let worktreePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "driver-engine-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, "docs", "tasks"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "tasks", "a.md"), "# task a\n");
    writeFileSync(join(repoRoot, "docs", "tasks", "b.md"), "# task b\n");
    writeFileSync(join(repoRoot, "docs", "tasks", "c.md"), "# task c\n");

    worktreePath = join(repoRoot, ".claude", "worktrees", "feat-a");
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-b"), { recursive: true });

    manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T00:00:00Z
generated_by: test
source:
  project: ship
  phase: engine-test
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: local
        status: pending
  - id: 2
    depends_on: [1]
    streams:
      - spec_path: docs/tasks/b.md
        branch_name: feat-b
        runtime: local
        status: pending
---
# driver
`,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("golden-manifest walk dispatches batch 1 before batch 2", async () => {
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const docB = resolveDocPath(repoRoot, "docs/tasks/b.md");
    const { port } = createFakeShipPort([
      { docPath: docA, repo: "ship", workflowRunId: "wf_a" },
      { docPath: docB, repo: "ship", workflowRunId: "wf_b" },
    ]);

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: port, store });
    const imported = driver.importManifest(manifestPath);

    const result = await driver.run(
      { driverRunId: imported.run.id },
      { maxWaitMs: 0, pollIntervalMs: 1000 },
    );

    expect(result.status).toBe("blocked_on_merges");
    expect(result.unmerged).toHaveLength(1);
    expect(result.unmerged[0]?.specPath).toBe("docs/tasks/a.md");

    driver.markMerged(imported.run.id, result.unmerged[0]!.streamId, {
      mergeCommit: "abc123",
      prNumber: 1,
    });

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0, pollIntervalMs: 1000 });
    store.close();
  });

  test("failed-retry path: fail → judgment → retry → re-dispatch", async () => {
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const { port } = createFakeShipPort([
      {
        docPath: docA,
        failureCategory: "timeout-near-cap",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_fail",
      },
      { docPath: docA, repo: "ship", workflowRunId: "wf_retry" },
    ]);

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: port, store });
    const imported = driver.importManifest(manifestPath);

    const first = await driver.run({ driverRunId: imported.run.id }, { batch: 1, maxWaitMs: 0 });
    expect(first.status).toBe("awaiting_judgment");
    expect(first.awaiting[0]?.kind).toBe("failure-triage");

    const triage = first.awaiting[0];
    if (triage?.kind !== "failure-triage") throw new Error("expected failure-triage");
    driver.decide(imported.run.id, triage.streamId, { kind: "retry" });

    await driver.run({ driverRunId: imported.run.id }, { batch: 1, maxWaitMs: 0 });
    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.attempts.length).toBe(2);
    expect(stream?.workflowRunId).toBe("wf_retry");
    store.close();
  });

  test("two-run plan determinism", async () => {
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const scripts = [{ docPath: docA, repo: "ship", workflowRunId: "wf_det" }];
    const store1 = createStore({ dbPath: ":memory:" });
    const store2 = createStore({ dbPath: ":memory:" });
    const fake1 = createFakeShipPort(scripts);
    const fake2 = createFakeShipPort(scripts);
    const driver1 = createDriverService({ rng: () => 0.5, ship: fake1.port, store: store1 });
    const driver2 = createDriverService({ rng: () => 0.5, ship: fake2.port, store: store2 });

    const r1 = driver1.importManifest(manifestPath);
    const r2 = driver2.importManifest(manifestPath);

    const t1 = await driver1.run({ driverRunId: r1.run.id }, { batch: 1, maxWaitMs: 0 });
    const t2 = await driver2.run({ driverRunId: r2.run.id }, { batch: 1, maxWaitMs: 0 });

    expect(t1.progress).toEqual(t2.progress);
    expect(normalizeForDeterminism(t1.streams)).toEqual(normalizeForDeterminism(t2.streams));
    store1.close();
    store2.close();
  });

  test("lease: live tick refusal and force takeover", async () => {
    const nowMs = Date.parse("2026-06-12T00:00:00.000Z");
    const store = createStore({
      clock: () => new Date(nowMs).toISOString(),
      dbPath: ":memory:",
    });
    const imported = createDriverService({
      clock: () => nowMs,
      ship: createFakeShipPort([]).port,
      store,
    }).importManifest(manifestPath);

    store.stampDriverRunTickStarted(imported.run.id);
    const run = store.getDriverRun(imported.run.id)!;
    expect(isTickLive(run, 1000, () => nowMs)).toBe(true);

    const driver = createDriverService({
      clock: () => nowMs,
      ship: createFakeShipPort([]).port,
      store,
    });
    await expect(
      driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0, pollIntervalMs: 1000 }),
    ).rejects.toThrow(TickLiveError);

    await driver.run(
      { driverRunId: imported.run.id },
      { force: true, maxWaitMs: 0, pollIntervalMs: 1000 },
    );
    store.close();
  });

  test("cancel is idempotent", async () => {
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      { docPath: docA, repo: "ship", terminalStatus: "running", workflowRunId: "wf_live" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);

    await driver.run({ driverRunId: imported.run.id }, { batch: 1, maxWaitMs: 0 });
    const cancelled = await driver.cancel(imported.run.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await driver.cancel(imported.run.id)).status).toBe("cancelled");
    store.close();
  });

  test("recovery: zero candidates reverts to pending", async () => {
    const store = createStore({ dbPath: ":memory:" });
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    const docPath = resolveDocPath(repoRoot, "docs/tasks/a.md");

    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batchId,
          status: "pending",
          streams: [
            {
              attempts: [{ dispatchedAt: "2026-06-12T00:00:00.000Z", docPath, terminal: false }],
              branch: "feat-a",
              id: streamId,
              runtime: "local",
              specPath: "docs/tasks/a.md",
              status: "dispatching",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath,
      repo: "ship",
      sourceJson: minimalSourceJson(),
      status: "running",
    });

    const ambiguities: DispatchAmbiguity[] = [];
    const run = store.getDriverRun(runId)!;
    await recoverDispatchingStreams(store, createFakeShipPort([]).port, run, ambiguities);
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.status).toBe("pending");
    store.close();
  });

  test("resolveRepoRoot finds .git ancestor", () => {
    expect(resolveRepoRoot(manifestPath)).toBe(repoRoot);
  });

  test("sticky terminal run returns immediately", async () => {
    const store = createStore({ dbPath: ":memory:" });
    const runId = newDriverRunId();
    store.insertDriverRun({
      batches: [],
      id: runId,
      manifestPath: join(tmpDir, "x.md"),
      repo: "ship",
      sourceJson: minimalSourceJson(),
      status: "done",
    });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("done");
    store.close();
  });

  test("rooms runtime dispatches through local worktree path", async () => {
    const manifest = join(repoRoot, "rooms.driver.md");
    writeFileSync(
      manifest,
      `---
driver_version: 1
generated_at: 2026-06-12T03:00:00Z
generated_by: test
source:
  project: ship
  phase: rooms
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: rooms
        status: pending
---
`,
    );
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([{ docPath: docA, repo: "ship", workflowRunId: "wf_rooms" }]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifest);
    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });
    expect(fake.calls.some((c) => c.kind === "startShip")).toBe(true);
    store.close();
  });

  test("all skipped streams yields done", async () => {
    const manifest = join(repoRoot, "skipped.driver.md");
    writeFileSync(
      manifest,
      `---
driver_version: 1
generated_at: 2026-06-12T04:00:00Z
generated_by: test
source:
  project: ship
  phase: skipped
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        status: skipped
---
`,
    );
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const imported = driver.importManifest(manifest);
    const result = await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });
    expect(result.status).toBe("done");
    store.close();
  });

  test("cloud stream without repo_url fails preflight", async () => {
    const cloudManifestPath = join(repoRoot, "cloud-only.driver.md");
    writeFileSync(
      cloudManifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T02:00:00Z
generated_by: test
source:
  project: ship
  phase: cloud
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        runtime: cloud
        status: pending
---
`,
    );

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const imported = driver.importManifest(cloudManifestPath);
    await expect(driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 })).rejects.toThrow(
      /repo_url/,
    );
    store.close();
  });

  test("dispatch-ambiguity pauses tick with awaiting_judgment", async () => {
    const store = createStore({ dbPath: ":memory:" });
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    const docPath = resolveDocPath(repoRoot, "docs/tasks/a.md");

    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: batchId,
          status: "pending",
          streams: [
            {
              attempts: [{ dispatchedAt: "2026-06-12T00:00:00.000Z", docPath, terminal: false }],
              branch: "feat-a",
              id: streamId,
              runtime: "local",
              specPath: "docs/tasks/a.md",
              status: "dispatching",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath,
      repo: "ship",
      sourceJson: minimalSourceJson(),
      status: "running",
    });

    const runs = Array.from({ length: 200 }, (_, i) => ({
      baseRef: "main",
      createdAt: "2026-06-12T00:00:01.000Z",
      docPath,
      id: `wf_dup_${String(i)}`,
      phases: [],
      policy: { agentTimeoutMs: 1, baseRef: "main", maxRunDurationMs: 1 },
      repo: "ship",
      status: "running" as const,
      updatedAt: "2026-06-12T00:00:01.000Z",
      worktree: {
        baseRef: "main",
        branch: "feat-a",
        name: "feat-a",
        path: "/wt",
        repo: "ship",
      },
    }));
    const { port } = createFakeShipPort([]);
    port.listRuns = () => Promise.resolve(runs);

    const driver = createDriverService({ ship: port, store });
    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("awaiting_judgment");
    expect(result.awaiting.some((a) => a.kind === "dispatch-ambiguity")).toBe(true);
    store.close();
  });

  test("pre-flight fails on missing worktree", async () => {
    rmSync(worktreePath, { force: true, recursive: true });
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const imported = driver.importManifest(manifestPath);
    await expect(driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 })).rejects.toThrow(
      /missing worktree/,
    );
    store.close();
  });
});

function minimalSourceJson(): string {
  return `---
driver_version: 1
generated_at: 2026-06-12T00:00:00Z
generated_by: test
source:
  project: ship
  phase: engine-test
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: local
---
`;
}

function normalizeForDeterminism(views: DriverStreamView[]): unknown[] {
  return views.map(({ batchIndex, runtime, specPath, status }) => ({
    batchIndex,
    runtime,
    specPath,
    status,
  }));
}

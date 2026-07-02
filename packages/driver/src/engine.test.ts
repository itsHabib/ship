/** Engine tick loop tests — fake clock, fake port, in-memory store. */

import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DriverStreamView } from "./types.js";

import {
  buildShipInputForTest,
  flipStreamToCloud,
  isTickLive,
  resolveDocPath,
  resolveRepoRoot,
  resolveRunawayBackstopMs,
  resolveRunOpts,
  shouldGiveUpTick,
} from "./engine.js";
import { TickLiveError } from "./errors.js";
import { type DispatchAmbiguity, recoverDispatchingStreams } from "./judgment.js";
import { createDriverService } from "./service.js";
import { createFakeGhPort } from "./test/fake-gh-port.js";
import { createFakeShipPort } from "./test/fake-ship-port.js";

const noopProgress = (): void => undefined;

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
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const docB = localDoc(repoRoot, "feat-b", "docs/tasks/b.md");
    const fake = createFakeShipPort([
      { docPath: docA, repo: "ship", workflowRunId: "wf_a" },
      { docPath: docB, repo: "ship", workflowRunId: "wf_b" },
    ]);
    const { port } = fake;

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

    // Local docs must resolve INSIDE the stream's worktree — core requires
    // docPath to be a descendant of workdir.
    const start = fake.calls.find((c) => c.kind === "startShip");
    expect((start?.input as { docPath?: string } | undefined)?.docPath).toBe(docA);

    driver.markMerged(imported.run.id, result.unmerged[0]!.streamId, {
      mergeCommit: "abc123",
      prNumber: 1,
    });

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0, pollIntervalMs: 1000 });
    store.close();
  });

  test("failed-retry path: fail → judgment → retry → re-dispatch", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
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

  test("awaiting_judgment writes stream-parked escalation before notify", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const notifyCalls: string[] = [];
    const exec = async (_cmd: string, payload: string) => {
      notifyCalls.push(payload);
      await Promise.resolve();
    };
    const { port } = createFakeShipPort([
      {
        docPath: docA,
        failureCategory: "timeout-near-cap",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_fail",
      },
    ]);

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({
      notifyExec: exec,
      ship: port,
      store,
    });
    const imported = driver.importManifest(manifestPath);

    const first = await driver.run(
      { driverRunId: imported.run.id },
      {
        batch: 1,
        escalation: { tiers: { "stream-parked": "page" } },
        maxWaitMs: 0,
        notify: { command: "test-notify" },
      },
    );
    expect(first.status).toBe("awaiting_judgment");

    const rows = store.listEscalations({
      class: "stream-parked",
      driverRunId: imported.run.id,
      unresolvedOnly: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notifiedAt).toBeDefined();
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(notifyCalls[0]!) as { class: string; v: number };
    expect(payload.class).toBe("stream-parked");
    expect(payload.v).toBe(1);

    const triage = first.awaiting[0];
    if (triage?.kind !== "failure-triage") throw new Error("expected failure-triage");
    driver.decide(imported.run.id, triage.streamId, { kind: "skip", reason: "won't fix" });

    const resolved = store.listEscalations({
      class: "stream-parked",
      driverRunId: imported.run.id,
      unresolvedOnly: true,
    });
    expect(resolved).toHaveLength(0);
    store.close();
  });

  test("queue-tier stream-parked never spawns notify", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    let notifyCalls = 0;
    const exec = async () => {
      notifyCalls += 1;
      await Promise.resolve();
    };
    const { port } = createFakeShipPort([
      {
        docPath: docA,
        failureCategory: "timeout-near-cap",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_fail",
      },
    ]);

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({
      notifyExec: exec,
      ship: port,
      store,
    });
    const imported = driver.importManifest(manifestPath);

    await driver.run(
      { driverRunId: imported.run.id },
      { batch: 1, maxWaitMs: 0, notify: { command: "test-notify" } },
    );
    expect(notifyCalls).toBe(0);
    const rows = store.listEscalations({ class: "stream-parked", driverRunId: imported.run.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notifiedAt).toBeUndefined();
    store.close();
  });

  test("two-run plan determinism", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
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
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
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

  test("rooms runtime is rejected at pre-flight, nothing dispatches", async () => {
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
    const fake = createFakeShipPort([]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifest);
    await expect(driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 })).rejects.toThrow(
      /rooms stream .* not supported/,
    );
    expect(fake.calls.some((c) => c.kind === "startShip")).toBe(false);
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
    const run = store.getDriverRun(imported.run.id);
    expect(run?.batches[0]?.status).toBe("done");
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

    // §7.3's documented alternative to adopt: retry abandons the candidates.
    driver.decide(runId, streamId, { kind: "retry" });
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.status).toBe("pending");
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

  test("dispatch-time failure surfaces a triage request without a workflow id", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const fake = createFakeShipPort([
      { docPath: docA, repo: "ship", throwOnStart: new Error("boom"), workflowRunId: "wf_never" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);

    const result = await driver.run({ driverRunId: imported.run.id }, { batch: 1, maxWaitMs: 0 });
    expect(result.status).toBe("awaiting_judgment");
    expect(result.awaiting).toHaveLength(1);
    const triage = result.awaiting[0];
    if (triage?.kind !== "failure-triage") throw new Error("expected failure-triage");
    expect(triage.workflowRunId).toBeUndefined();
    expect(triage.failureCategory).toBe("sdk-throw");
    expect(triage.errorMessage).toBe("boom");
    store.close();
  });

  test("failed dispatch does not consume a parallelism slot", async () => {
    const manifest = join(repoRoot, "two-cloud.driver.md");
    writeFileSync(manifest, twoCloudStreamManifest("2026-06-12T05:00:00Z"));
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const docB = resolveDocPath(repoRoot, "docs/tasks/b.md");
    const fake = createFakeShipPort([
      { docPath: docA, repo: "ship", throwOnStart: new Error("quota"), workflowRunId: "wf_x" },
      { docPath: docB, repo: "ship", terminalStatus: "running", workflowRunId: "wf_b" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifest);

    await driver.run({ driverRunId: imported.run.id }, { maxParallel: { cloud: 1 }, maxWaitMs: 0 });

    const startCalls = fake.calls.filter((c) => c.kind === "startShip");
    expect(startCalls).toHaveLength(2);
    const streams = store.getDriverRun(imported.run.id)?.batches[0]?.streams;
    expect(streams?.find((s) => s.specPath === "docs/tasks/a.md")?.status).toBe("failed");
    expect(streams?.find((s) => s.specPath === "docs/tasks/b.md")?.status).toBe("dispatched");
    store.close();
  });

  test("cloud cap limits dispatch within a multi-stream batch", async () => {
    const manifest = join(repoRoot, "capped-cloud.driver.md");
    writeFileSync(manifest, twoCloudStreamManifest("2026-06-12T06:00:00Z"));
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const docB = resolveDocPath(repoRoot, "docs/tasks/b.md");
    const fake = createFakeShipPort([
      { docPath: docA, repo: "ship", terminalStatus: "running", workflowRunId: "wf_a" },
      { docPath: docB, repo: "ship", terminalStatus: "running", workflowRunId: "wf_b" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifest);

    await driver.run({ driverRunId: imported.run.id }, { maxParallel: { cloud: 1 }, maxWaitMs: 0 });

    expect(fake.calls.filter((c) => c.kind === "startShip")).toHaveLength(1);
    store.close();
  });

  test("post-dispatch persistence failure leaves the stream dispatching for recovery", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const fake = createFakeShipPort([{ docPath: docA, repo: "ship", workflowRunId: "wf_live" }]);
    const store = createStore({ dbPath: ":memory:" });
    const imported = createDriverService({ ship: fake.port, store }).importManifest(manifestPath);

    const failingStore: typeof store = {
      ...store,
      updateDriverStream: (id, patch) => {
        if (patch.status === "dispatched") throw new Error("contention");
        return store.updateDriverStream(id, patch);
      },
    };
    const failingDriver = createDriverService({ ship: fake.port, store: failingStore });
    await expect(
      failingDriver.run({ driverRunId: imported.run.id }, { batch: 1, maxWaitMs: 0 }),
    ).rejects.toThrow(/contention/);

    const stuck = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stuck?.status).toBe("dispatching");

    // Next tick adopts the live workflow via §7.3 instead of re-dispatching.
    const driver = createDriverService({ ship: fake.port, store });
    await driver.run({ driverRunId: imported.run.id }, { batch: 1, maxWaitMs: 0 });
    const recovered = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(recovered?.workflowRunId).toBe("wf_live");
    expect(fake.calls.filter((c) => c.kind === "startShip")).toHaveLength(1);
    store.close();
  });

  test("stale lease is taken over without force", async () => {
    const t0 = Date.parse("2026-06-12T00:00:00.000Z");
    const store = createStore({ clock: () => new Date(t0).toISOString(), dbPath: ":memory:" });
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const fake = createFakeShipPort([{ docPath: docA, repo: "ship", workflowRunId: "wf_stale" }]);
    const imported = createDriverService({ ship: fake.port, store }).importManifest(manifestPath);
    store.stampDriverRunTickStarted(imported.run.id);

    const driver = createDriverService({ clock: () => t0 + 3001, ship: fake.port, store });
    const result = await driver.run(
      { driverRunId: imported.run.id },
      { batch: 1, maxWaitMs: 0, pollIntervalMs: 1000 },
    );
    expect(result.status).toBe("blocked_on_merges");
    store.close();
  });

  test("cloud landed stream adopts the cursor-chosen branch", async () => {
    const manifest = join(repoRoot, "cloud-branchless.driver.md");
    writeFileSync(
      manifest,
      `---
driver_version: 1
generated_at: 2026-06-12T07:00:00Z
generated_by: test
source:
  project: ship
  phase: cloud-branch
repo: ship
repo_url: https://github.com/example/ship
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
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        branchName: "cursor/auto-1a2b",
        docPath: docA,
        prUrl: "https://github.com/example/ship/pull/9",
        repo: "ship",
        workflowRunId: "wf_cloud",
      },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const gh = createFakeGhPort({ 9: { isDraft: true, state: "OPEN" } });
    const driver = createDriverService({ gh, ship: fake.port, store });
    const imported = driver.importManifest(manifest);

    const result = await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");
    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("landed");
    expect(stream?.branch).toBe("cursor/auto-1a2b");
    expect(stream?.prUrl).toBe("https://github.com/example/ship/pull/9");
    expect(gh.markReadyCalls).toEqual([{ prNumber: 9, repo: "https://github.com/example/ship" }]);
    store.close();
  });

  test("cloud succeeded stream with draft PR calls markReady once", async () => {
    const manifest = join(repoRoot, "cloud-draft-flip.driver.md");
    writeFileSync(
      manifest,
      `---
driver_version: 1
generated_at: 2026-07-02T00:00:00Z
generated_by: test
source:
  project: ship
  phase: cloud-draft-flip
repo: ship
repo_url: https://github.com/example/ship
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
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: docA,
        prUrl: "https://github.com/example/ship/pull/42",
        repo: "ship",
        workflowRunId: "wf_draft",
      },
    ]);
    const gh = createFakeGhPort({ 42: { isDraft: true, state: "OPEN" } });
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store });
    const imported = driver.importManifest(manifest);

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });

    expect(gh.markReadyCalls).toEqual([{ prNumber: 42, repo: "https://github.com/example/ship" }]);
    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("landed");
    store.close();
  });

  test("cloud markReady is idempotent when PR is already ready", async () => {
    const manifest = join(repoRoot, "cloud-ready-noop.driver.md");
    writeFileSync(
      manifest,
      `---
driver_version: 1
generated_at: 2026-07-02T00:00:00Z
generated_by: test
source:
  project: ship
  phase: cloud-ready-noop
repo: ship
repo_url: https://github.com/example/ship
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
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: docA,
        prUrl: "https://github.com/example/ship/pull/55",
        repo: "ship",
        workflowRunId: "wf_ready",
      },
    ]);
    const gh = createFakeGhPort({ 55: { isDraft: false, state: "OPEN" } });
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store });
    const imported = driver.importManifest(manifest);

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });

    expect(gh.markReadyCalls).toEqual([{ prNumber: 55, repo: "https://github.com/example/ship" }]);
    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("landed");
    store.close();
  });

  test("cloud markReady failure parks the stream with a legible error", async () => {
    const manifest = join(repoRoot, "cloud-flip-fail.driver.md");
    writeFileSync(
      manifest,
      `---
driver_version: 1
generated_at: 2026-07-02T00:00:00Z
generated_by: test
source:
  project: ship
  phase: cloud-flip-fail
repo: ship
repo_url: https://github.com/example/ship
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
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        branchName: "cursor/flip-77",
        docPath: docA,
        prUrl: "https://github.com/example/ship/pull/77",
        repo: "ship",
        workflowRunId: "wf_flip_fail",
      },
    ]);
    const gh = createFakeGhPort({
      77: { isDraft: true, markReadyError: "gh pr ready denied", state: "OPEN" },
    });
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store });
    const imported = driver.importManifest(manifest);

    const result = await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });

    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("failed");
    expect(stream?.errorMessage).toBe("draft→ready flip failed: gh pr ready denied");
    expect(stream?.prUrl).toBe("https://github.com/example/ship/pull/77");
    expect(stream?.branch).toBe("cursor/flip-77");
    expect(result.status).toBe("awaiting_judgment");
    store.close();
  });

  test("local succeeded stream does not call markReady", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: docA,
        prUrl: "https://github.com/example/ship/pull/99",
        repo: "ship",
        workflowRunId: "wf_local_pr",
      },
    ]);
    const gh = createFakeGhPort({ 99: { isDraft: true, state: "OPEN" } });
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });

    expect(gh.markReadyCalls).toEqual([]);
    store.close();
  });

  test("tiered stream dispatches mapped model on ShipInput", async () => {
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-07-01T00:00:00Z
generated_by: test
source:
  project: ship
  phase: tier-dispatch
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: local
        model: fable
        status: pending
---
`,
    );
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const fake = createFakeShipPort([{ docPath: docA, repo: "ship", workflowRunId: "wf_tier" }]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });

    const start = fake.calls.find((c) => c.kind === "startShip");
    expect(start?.input).toMatchObject({
      model: "composer-2.5",
      modelParams: [{ id: "fast", value: "true" }],
    });

    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.modelTier).toBe("fable");
    expect(stream?.dispatchModel).toBe("composer-2.5");
    expect(stream?.dispatchProvider).toBe("cursor");
    store.close();
  });

  test("legacy stream without tiers produces unchanged ShipInput", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const fake = createFakeShipPort([{ docPath: docA, repo: "ship", workflowRunId: "wf_legacy" }]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });

    const start = fake.calls.find((c) => c.kind === "startShip");
    expect(start?.input).not.toHaveProperty("model");
    expect(start?.input).not.toHaveProperty("modelParams");
    store.close();
  });

  test("claude cloud stream dispatches provider and prBranch on ShipInput", async () => {
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-07-02T00:00:00Z
generated_by: test
source:
  project: ship
  phase: claude-cloud-dispatch
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-claude
        runtime: cloud
        provider: claude
        model: opus
        status: pending
---
`,
    );
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      { docPath: docA, repo: "ship", workflowRunId: "wf_claude_cloud" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });

    const start = fake.calls.find((c) => c.kind === "startShip");
    expect(start?.input).toMatchObject({
      provider: "claude",
      runtime: "cloud",
      cloud: {
        repos: [{ url: "https://github.com/example/ship", prBranch: "feat-claude" }],
      },
    });

    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.provider).toBe("claude");
    expect(stream?.dispatchProvider).toBe("claude");
    store.close();
  });
});

describe("buildShipInputForTest", () => {
  let tmpDir: string;
  let repoRoot: string;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "driver-ship-input-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("forwards provider and prBranch when set on claude cloud stream", () => {
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
              branch: "feat-claude",
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
      manifestPath: join(repoRoot, "driver.md"),
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\nrepo_url: https://github.com/example/ship\n---\n",
      status: "pending",
    });

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream).toBeDefined();
    const input = buildShipInputForTest(
      {
        clock: () => 0,
        cloudInFlight: 0,
        localInFlight: 0,
        onProgress: noopProgress,
        opts: resolveRunOpts(),
        repoRoot,
        repoUrl: "https://github.com/example/ship",
        runId,
        ship: createFakeShipPort([]).port,
        store,
      },
      stream!,
      "docs/a.md",
    );
    expect(input).toMatchObject({
      provider: "claude",
      runtime: "cloud",
      cloud: { repos: [{ url: "https://github.com/example/ship", prBranch: "feat-claude" }] },
    });
  });

  test("omits provider when unset so ShipInput matches legacy cursor shape", () => {
    const runId = newDriverRunId();
    const batchId = newDriverBatchId();
    const streamId = newDriverStreamId();
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });
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
              branch: "feat-a",
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
      id: runId,
      manifestPath: join(repoRoot, "driver.md"),
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream).toBeDefined();
    const input = buildShipInputForTest(
      {
        clock: () => 0,
        cloudInFlight: 0,
        localInFlight: 0,
        onProgress: noopProgress,
        opts: resolveRunOpts(),
        repoRoot,
        repoUrl: undefined,
        runId,
        ship: createFakeShipPort([]).port,
        store,
      },
      stream!,
      "docs/a.md",
    );
    expect(input).not.toHaveProperty("provider");
    expect(input).toMatchObject({
      branch: "feat-a",
      runtime: "local",
      workdir: join(repoRoot, ".claude", "worktrees", "feat-a"),
    });
  });

  test("propagates startingRef and workOnCurrentBranch when set on cloud stream", () => {
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
              branch: "feat-continue",
              id: streamId,
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
      manifestPath: join(repoRoot, "driver.md"),
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\nrepo_url: https://github.com/example/ship\n---\n",
      status: "pending",
    });

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream).toBeDefined();
    store.updateDriverStream(streamId, { workOnCurrentBranch: true });
    const persisted = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(persisted?.workOnCurrentBranch).toBe(true);
    const input = buildShipInputForTest(
      {
        clock: () => 0,
        cloudInFlight: 0,
        localInFlight: 0,
        onProgress: noopProgress,
        opts: resolveRunOpts(),
        repoRoot,
        repoUrl: "https://github.com/example/ship",
        runId,
        ship: createFakeShipPort([]).port,
        store,
      },
      persisted!,
      "docs/a.md",
    );
    expect(input).toMatchObject({
      runtime: "cloud",
      startingRef: "feat-continue",
      cloud: {
        repos: [{ url: "https://github.com/example/ship", startingRef: "feat-continue" }],
        workOnCurrentBranch: true,
      },
    });
  });

  test("default cloud path is unchanged when continuation fields are absent", () => {
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
      manifestPath: join(repoRoot, "driver.md"),
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\nrepo_url: https://github.com/example/ship\n---\n",
      status: "pending",
    });

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream).toBeDefined();
    const input = buildShipInputForTest(
      {
        clock: () => 0,
        cloudInFlight: 0,
        localInFlight: 0,
        onProgress: noopProgress,
        opts: resolveRunOpts(),
        repoRoot,
        repoUrl: "https://github.com/example/ship",
        runId,
        ship: createFakeShipPort([]).port,
        store,
      },
      stream!,
      "docs/a.md",
    );
    expect(input).toMatchObject({
      runtime: "cloud",
      cloud: {
        autoCreatePR: true,
        env: { type: "cloud" },
        repos: [{ url: "https://github.com/example/ship" }],
        workOnCurrentBranch: false,
      },
    });
    expect(input).not.toHaveProperty("startingRef");
  });
});

describe("flipStreamToCloud", () => {
  let tmpDir: string;
  let repoRoot: string;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "driver-flip-cloud-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "a.md"), "# task\n");
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("re-dispatches to cloud with continuation ref from the local branch", async () => {
    const manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-26T00:00:00Z
generated_by: test
source:
  project: ship
  phase: flip
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/a.md
        branch_name: feat-a
        runtime: local
        status: pending
---
`,
    );
    const fake = createFakeShipPort([
      { docPath: join(repoRoot, "docs", "a.md"), repo: "ship", workflowRunId: "wf_flip_cloud" },
    ]);
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);
    const streamId = imported.run.batches[0]?.streams[0]?.id;
    expect(streamId).toBeDefined();

    await flipStreamToCloud(store, fake.port, imported.run.id, streamId!, () => 0);

    const start = fake.calls.find((c) => c.kind === "startShip");
    expect(start?.input).toMatchObject({
      runtime: "cloud",
      startingRef: "feat-a",
      cloud: {
        repos: [{ url: "https://github.com/example/ship", startingRef: "feat-a" }],
        workOnCurrentBranch: true,
      },
    });
    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("cloud");
    expect(stream?.status).toBe("dispatched");
    expect(stream?.workOnCurrentBranch).toBe(true);
  });

  test("retry re-dispatch after flip keeps branch continuation on the stream row", async () => {
    const manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-26T00:00:00Z
generated_by: test
source:
  project: ship
  phase: flip-retry
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/a.md
        branch_name: feat-a
        runtime: local
        status: pending
---
`,
    );
    const docPath = join(repoRoot, "docs", "a.md");
    const fake = createFakeShipPort([
      {
        docPath,
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_flip_fail",
      },
    ]);
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);
    const streamId = imported.run.batches[0]?.streams[0]?.id;
    expect(streamId).toBeDefined();

    await flipStreamToCloud(store, fake.port, imported.run.id, streamId!, () => 0);
    store.updateDriverStream(streamId!, { status: "failed" });
    store.updateDriverRunStatus(imported.run.id, "awaiting_judgment");
    driver.decide(imported.run.id, streamId!, { kind: "retry" });

    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("cloud");
    expect(stream?.workOnCurrentBranch).toBe(true);
    const input = buildShipInputForTest(
      {
        clock: () => 0,
        cloudInFlight: 0,
        localInFlight: 0,
        onProgress: noopProgress,
        opts: resolveRunOpts(),
        repoRoot,
        repoUrl: "https://github.com/example/ship",
        runId: imported.run.id,
        ship: fake.port,
        store,
      },
      stream!,
      docPath,
    );
    expect(input.cloud?.repos[0]?.startingRef).toBe("feat-a");
    expect(input.cloud?.workOnCurrentBranch).toBe(true);
  });
});

describe("liveness-aware tick give-up", () => {
  let tmpDir: string;
  let repoRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "driver-liveness-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, "docs", "tasks"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "tasks", "a.md"), "# task a\n");
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });
    manifestPath = join(repoRoot, "liveness.driver.md");
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-26T00:00:00Z
generated_by: test
source:
  project: ship
  phase: liveness
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: local
        status: pending
---
`,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("shouldGiveUpTick uses monotonic inactivity, not wall clock", () => {
    const opts = { maxWaitMs: 5000, runawayBackstopMs: 120_000 };
    expect(shouldGiveUpTick(4000, { lastProgressMono: 0, tickStartedMono: 0 }, opts)).toBe(false);
    expect(shouldGiveUpTick(5000, { lastProgressMono: 0, tickStartedMono: 0 }, opts)).toBe(true);
    expect(shouldGiveUpTick(5999, { lastProgressMono: 5500, tickStartedMono: 0 }, opts)).toBe(
      false,
    );
  });

  test("shouldGiveUpTick hits runaway backstop even with recent progress", () => {
    const opts = { maxWaitMs: 5000, runawayBackstopMs: 10_000 };
    expect(shouldGiveUpTick(10_000, { lastProgressMono: 9999, tickStartedMono: 0 }, opts)).toBe(
      true,
    );
  });

  test("resolveRunawayBackstopMs defaults to at least two hours", () => {
    expect(resolveRunawayBackstopMs(1000)).toBe(DEFAULT_TWO_HOUR_MS);
    expect(resolveRunawayBackstopMs(30 * 60 * 1000)).toBe(30 * 60 * 1000 * 6);
  });

  test("survives wall-clock jump while workflow runs keep emitting", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    let wallMs = 0;
    let monoMs = 0;
    let sleepCalls = 0;

    const fake = createFakeShipPort(
      [{ docPath: docA, repo: "ship", terminalStatus: "running", workflowRunId: "wf_live" }],
      () => wallMs,
    );
    const baseGetRun = fake.port.getRun.bind(fake.port);
    fake.port.getRun = async (workflowRunId) => {
      const run = await baseGetRun(workflowRunId);
      if (run === null) return null;
      monoMs += 100;
      wallMs += 60 * 60 * 1000;
      fake.runs.set(workflowRunId, {
        ...run,
        updatedAt: new Date(monoMs).toISOString(),
      });
      return fake.runs.get(workflowRunId) ?? null;
    };

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({
      clock: () => wallMs,
      monotonicClock: () => monoMs,
      rng: () => 0.5,
      ship: fake.port,
      sleep: (ms) => {
        sleepCalls += 1;
        monoMs += ms;
        if (sleepCalls >= 4) {
          const live = fake.runs.get("wf_live");
          if (live !== undefined) {
            fake.runs.set("wf_live", { ...live, status: "succeeded" });
          }
        }
        return Promise.resolve();
      },
      store,
    });
    const imported = driver.importManifest(manifestPath);

    const result = await driver.run(
      { driverRunId: imported.run.id },
      { batch: 1, maxWaitMs: 30_000, pollIntervalMs: 3000, runawayBackstopMs: 120_000 },
    );

    expect(sleepCalls).toBeGreaterThanOrEqual(4);
    expect(result.status).toBe("blocked_on_merges");
    store.close();
  });

  test("gives up after inactivity window with no workflow progress", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    let monoMs = 0;

    const fake = createFakeShipPort(
      [{ docPath: docA, repo: "ship", terminalStatus: "running", workflowRunId: "wf_stuck" }],
      () => monoMs,
    );

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({
      monotonicClock: () => monoMs,
      rng: () => 0.5,
      ship: fake.port,
      sleep: (ms) => {
        monoMs += ms;
        return Promise.resolve();
      },
      store,
    });
    const imported = driver.importManifest(manifestPath);

    const result = await driver.run(
      { driverRunId: imported.run.id },
      {
        batch: 1,
        maxWaitMs: 5000,
        pollIntervalMs: 1000,
        runawayBackstopMs: 60_000,
      },
    );

    expect(result.status).toBe("running");
    expect(monoMs).toBeGreaterThanOrEqual(5000);
    const stream = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("dispatched");
    store.close();
  });

  test("gives up via runaway backstop when tick exceeds hard ceiling", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    let monoMs = 0;
    let eventTick = 0;

    const fake = createFakeShipPort(
      [{ docPath: docA, repo: "ship", terminalStatus: "running", workflowRunId: "wf_trickle" }],
      () => monoMs,
    );
    const baseGetRun = fake.port.getRun.bind(fake.port);
    fake.port.getRun = async (workflowRunId) => {
      const run = await baseGetRun(workflowRunId);
      if (run === null) return null;
      eventTick += 1;
      fake.runs.set(workflowRunId, {
        ...run,
        updatedAt: new Date(eventTick).toISOString(),
      });
      return fake.runs.get(workflowRunId) ?? null;
    };

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({
      monotonicClock: () => monoMs,
      rng: () => 0.5,
      ship: fake.port,
      sleep: (ms) => {
        monoMs += ms;
        return Promise.resolve();
      },
      store,
    });
    const imported = driver.importManifest(manifestPath);

    const result = await driver.run(
      { driverRunId: imported.run.id },
      {
        batch: 1,
        maxWaitMs: 60_000,
        pollIntervalMs: 1000,
        runawayBackstopMs: 8000,
      },
    );

    expect(result.status).toBe("running");
    expect(monoMs).toBeGreaterThanOrEqual(8000);
    expect(monoMs).toBeLessThan(60_000);
    store.close();
  });

  test("maxWaitMs zero bounded tick regression — one pass then progress", async () => {
    const docA = localDoc(repoRoot, "feat-a", "docs/tasks/a.md");
    const fake = createFakeShipPort([
      { docPath: docA, repo: "ship", terminalStatus: "running", workflowRunId: "wf_once" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const imported = driver.importManifest(manifestPath);

    const result = await driver.run(
      { driverRunId: imported.run.id },
      { batch: 1, maxWaitMs: 0, pollIntervalMs: 1000 },
    );

    expect(result.status).toBe("running");
    expect(store.getDriverRun(imported.run.id)?.batches[0]?.streams[0]?.status).toBe("dispatched");
    store.close();
  });
});

const DEFAULT_TWO_HOUR_MS = 2 * 60 * 60 * 1000;

function twoCloudStreamManifest(generatedAt: string): string {
  return `---
driver_version: 1
generated_at: ${generatedAt}
generated_by: test
source:
  project: ship
  phase: cloud-pair
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        runtime: cloud
        status: pending
      - spec_path: docs/tasks/b.md
        runtime: cloud
        status: pending
---
`;
}

/** Local docs resolve inside the stream's worktree (core requires it). */
function localDoc(root: string, branch: string, specPath: string): string {
  return resolveDocPath(join(root, ".claude", "worktrees", branch), specPath);
}

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

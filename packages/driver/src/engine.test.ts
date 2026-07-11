/** Engine tick loop tests — fake clock, fake port, in-memory store. */

import type { DriverStream } from "@ship/store";

import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DriverStreamView } from "./types.js";

import {
  address,
  buildShipInputForTest,
  flipStreamToCloud,
  isTickLive,
  resolveDocPath,
  resolveRepoRoot,
  resolveRunawayBackstopMs,
  resolveRunOpts,
  shouldGiveUpTick,
} from "./engine.js";
import { AddressError, TickLiveError } from "./errors.js";
import { type DispatchAmbiguity, recoverDispatchingStreams } from "./judgment.js";
import { canonicalReviewFindingsSha256, parseReviewFindings } from "./review-findings.js";
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

  test("decide retry after a failed flip re-runs the flip on the persisted prUrl", async () => {
    const manifest = join(repoRoot, "cloud-flip-retry.driver.md");
    writeFileSync(
      manifest,
      `---
driver_version: 1
generated_at: 2026-07-02T00:00:00Z
generated_by: test
source:
  project: ship
  phase: cloud-flip-retry
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
        branchName: "cursor/flip-88",
        docPath: docA,
        prUrl: "https://github.com/example/ship/pull/88",
        repo: "ship",
        workflowRunId: "wf_flip_retry",
      },
    ]);
    const prState = { isDraft: true, markReadyError: "gh pr ready denied", state: "OPEN" as const };
    const gh = createFakeGhPort({ 88: prState });
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store });
    const imported = driver.importManifest(manifest);

    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });
    const failed = store.getDriverRun(imported.run.id)?.batches[0]?.streams[0];
    expect(failed?.status).toBe("failed");
    expect(failed?.prUrl).toBe("https://github.com/example/ship/pull/88");

    // The prUrl persisted by the failed flip must not suppress the retry's flip.
    delete (prState as { markReadyError?: string }).markReadyError;
    driver.decide(imported.run.id, failed?.id ?? "", { kind: "retry" });
    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });

    expect(gh.markReadyCalls).toHaveLength(2);
    expect(store.getDriverRun(imported.run.id)?.batches[0]?.streams[0]?.status).toBe("landed");
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

describe("driver address", () => {
  let tmpDir: string;
  let repoRoot: string;
  let manifestPath: string;
  let findingsPath: string;
  let store: ReturnType<typeof createStore>;

  const PR_URL = "https://github.com/example/ship/pull/77";
  const HEAD_SHA = "0000000000000000000000000000000000000000";
  const SOURCE_JSON = `---
driver_version: 1
generated_at: 2026-07-09T00:00:00Z
generated_by: test
source:
  project: ship
  phase: address-test
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/a.md
        runtime: cloud
        status: pending
---
`;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "driver-address-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    manifestPath = join(repoRoot, "driver.md");
    findingsPath = join(repoRoot, "findings.json");
    writeFileSync(findingsPath, validFindingsArtifact());
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  interface SeedOpts {
    status?: string;
    runtime?: string;
    prUrl?: string | undefined;
    branch?: string | undefined;
    runStatus?: string;
    provider?: "claude" | "cursor";
    reviewCycles?: number;
  }

  function seed(opts: SeedOpts = {}): { runId: string; streamId: string } {
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
              ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
              id: streamId,
              ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
              ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
              runtime: (opts.runtime ?? "cloud") as "cloud" | "local",
              specPath: "docs/a.md",
              status: (opts.status ?? "landed") as "landed" | "pending" | "failed",
              streamIndex: 0,
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath,
      repo: "ship",
      sourceJson: SOURCE_JSON,
      status: (opts.runStatus ?? "running") as "running",
    });
    if (opts.reviewCycles !== undefined) {
      store.updateDriverStream(streamId, { reviewCycles: opts.reviewCycles });
    }
    return { runId, streamId };
  }

  function landedSeed(over: SeedOpts = {}): { runId: string; streamId: string } {
    return seed({ branch: "feat-a", prUrl: PR_URL, ...over });
  }

  // Single accessor for the seeded run's first stream — keeps the assertion
  // bodies below off a long optional-chain (each `?.` counts against the
  // per-function complexity budget).
  function firstStream(runId: string): DriverStream | undefined {
    return store.getDriverRun(runId)?.batches[0]?.streams[0];
  }

  function validFindingsArtifact(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schema_version: 1,
      artifact_id: "rf_test",
      decision: "address",
      subject: {
        type: "pull_request",
        repo: "example/ship",
        number: 77,
        head_sha: HEAD_SHA,
      },
      producer: {
        id: "review-coordinator",
        harness: "test",
        generated_at: "2026-07-10T00:00:00Z",
      },
      panel: { requested: ["codex"], completed: ["codex"], missing: [] },
      findings: [
        {
          id: "finding-1",
          severity: "high",
          summary: "fix the null deref in foo.ts",
          evidence: "foo() dereferences a nullable value",
          sources: [
            {
              reviewer: "codex",
              comment_id: "1",
              url: "https://github.com/example/ship/pull/77#discussion_r1",
            },
          ],
        },
      ],
      ...over,
    });
  }

  test("dispatches on the existing branch with autoCreatePR false and a findings doc", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
      findingsPath,
      streamId,
    });

    const start = fake.calls.find((c) => c.kind === "startShip");
    expect(start?.input).toMatchObject({
      runtime: "cloud",
      startingRef: "feat-a",
      cloud: {
        autoCreatePR: false,
        repos: [{ url: "https://github.com/example/ship", startingRef: "feat-a", prUrl: PR_URL }],
        workOnCurrentBranch: true,
      },
    });
    const dispatchedDoc = (start?.input as { docPath: string }).docPath;
    const docText = readFileSync(dispatchedDoc, "utf8");
    expect(docText).toContain("do not open a new PR");
    expect(docText).toContain("fix the null deref in foo.ts");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("dispatched");
    expect(stream?.reviewCycles).toBe(1);
    expect(stream?.workOnCurrentBranch).toBe(true);
  });

  test("increments reviewCycles exactly once per call", async () => {
    const { runId, streamId } = landedSeed({ reviewCycles: 1 });
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
      findingsPath,
      streamId,
    });

    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.reviewCycles).toBe(2);
  });

  test("refuses findings for a different subject or stale exact head", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { headRefOid: HEAD_SHA, state: "OPEN" } });

    writeFileSync(
      findingsPath,
      validFindingsArtifact({
        subject: {
          type: "pull_request",
          repo: "other/ship",
          number: 77,
          head_sha: HEAD_SHA,
        },
      }),
    );
    await expectRefusal(
      () => address({ gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      "findings-subject-mismatch",
    );

    writeFileSync(
      findingsPath,
      validFindingsArtifact({
        subject: {
          type: "pull_request",
          repo: "example/ship",
          number: 77,
          head_sha: "1".repeat(40),
        },
      }),
    );
    await expectRefusal(
      () => address({ gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      "findings-stale-head",
    );
    expect(fake.calls.some((call) => call.kind === "startShip")).toBe(false);
  });

  test("canonical replay with regenerated envelope dispatches at most once", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
      findingsPath,
      streamId,
    });
    store.updateDriverStream(streamId, { status: "landed" });
    writeFileSync(
      findingsPath,
      validFindingsArtifact({
        artifact_id: "rf_retry",
        producer: {
          id: "review-coordinator",
          harness: "claude",
          generated_at: "2026-07-10T01:00:00Z",
        },
      }),
    );

    await expectRefusal(
      () =>
        address({ clock: () => 1, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      "findings-duplicate",
    );
    expect(fake.calls.filter((call) => call.kind === "startShip")).toHaveLength(1);
  });

  test("two concurrent address calls produce exactly one dispatch", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });
    const call = () =>
      address({ clock: () => 0, gh, ship: fake.port, store }, runId, { findingsPath, streamId });

    const results = await Promise.allSettled([call(), call()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fake.calls.filter((entry) => entry.kind === "startShip")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      AddressError,
    );
  });

  test("a synthesized-doc write failure consumes nothing and retry can win", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });
    const files = {
      read: (path: string) => readFileSync(path, "utf8"),
      write: () => {
        throw new Error("disk full");
      },
    };

    await expect(
      address({ files, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
    ).rejects.toThrow(/disk full/u);
    expect(firstStream(runId)).toMatchObject({ attempts: [], status: "landed" });

    await expect(
      address({ gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
    ).resolves.toBeDefined();
    expect(fake.calls.filter((entry) => entry.kind === "startShip")).toHaveLength(1);
  });

  test("throws when the address dispatch fails, leaving the stream failed for decide retry", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const failingPort = { ...fake.port, startShip: () => Promise.reject(new Error("boom")) };
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await expect(
      address({ clock: () => 0, gh, ship: failingPort, store }, runId, {
        findingsPath,
        streamId,
      }),
    ).rejects.toThrow(/address dispatch failed/);

    const stream = firstStream(runId);
    expect(stream?.status).toBe("failed");
    // The call consumed a review cycle; the follow-up `decide retry` won't re-count.
    expect(stream?.reviewCycles).toBe(1);
    // The run is awaiting judgment so `decide retry` is legal without another tick.
    expect(store.getDriverRun(runId)?.status).toBe("awaiting_judgment");
  });

  test("a decide-retry re-dispatch resolves the findings doc and branch from the row alone", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
      findingsPath,
      streamId,
    });
    const synthesizedDoc = firstStream(runId)?.attempts.at(-1)?.docPath;
    expect(synthesizedDoc).toContain(`address-${streamId}-cycle1-`);

    // Simulate the address dispatch failing, then a `decide retry`.
    store.updateDriverStream(streamId, { status: "failed" });
    store.updateDriverRunStatus(runId, "awaiting_judgment");
    const driver = createDriverService({ gh, ship: fake.port, store });
    driver.decide(runId, streamId, { kind: "retry" });

    const retried = firstStream(runId);
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
        ship: fake.port,
        store,
      },
      retried!,
      // The tick resolves the latest attempt's docPath; assert that is the
      // synthesized findings doc, not the original spec.
      retried!.attempts.at(-1)!.docPath!,
    );
    expect((input as { docPath: string }).docPath).toBe(synthesizedDoc);
    expect(input.docPath).not.toBe("docs/a.md");
    expect(input.cloud?.repos[0]?.startingRef).toBe("feat-a");
    expect(input.cloud?.autoCreatePR).toBe(false);
    expect(input.cloud?.workOnCurrentBranch).toBe(true);
  });

  test("accepted on a run presenting blocked_on_merges (all streams landed)", async () => {
    const { runId, streamId } = landedSeed({ runStatus: "running" });
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await expect(
      address({ clock: () => 0, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
    ).resolves.toBeDefined();
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.status).toBe("dispatched");
  });

  test.each(["done", "failed", "cancelled"] as const)(
    "refuses run-not-addressable on sticky-terminal run status=%s",
    async (runStatus) => {
      const { runId, streamId } = landedSeed();
      store.updateDriverRunStatus(runId, runStatus);
      const fake = createFakeShipPort([]);
      const gh = createFakeGhPort({ 77: { state: "OPEN" } });

      await expectRefusal(
        () =>
          address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
            findingsPath,
            streamId,
          }),
        "run-not-addressable",
      );
      expect(fake.calls.some((c) => c.kind === "startShip")).toBe(false);
    },
  );

  test("a claude address dispatch carries prBranch, prUrl, and autoCreatePR false", async () => {
    const { runId, streamId } = landedSeed({ provider: "claude" });
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
      findingsPath,
      streamId,
    });

    const start = fake.calls.find((c) => c.kind === "startShip");
    expect(start?.input).toMatchObject({
      provider: "claude",
      cloud: {
        autoCreatePR: false,
        repos: [{ prBranch: "feat-a", prUrl: PR_URL }],
      },
    });
  });

  test("landed → address → poll succeeded → landed with same PR, no draft flip", async () => {
    const { runId, streamId } = landedSeed();
    const digest = canonicalReviewFindingsSha256(parseReviewFindings(validFindingsArtifact()));
    const synthesizedDoc = join(repoRoot, `address-${streamId}-cycle1-${digest.slice(0, 12)}.md`);
    const fake = createFakeShipPort([
      {
        branchName: "feat-a",
        docPath: synthesizedDoc,
        prUrl: PR_URL,
        repo: "ship",
        workflowRunId: "wf_addr",
      },
    ]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });
    const driver = createDriverService({ gh, ship: fake.port, store });

    await driver.address(runId, { findingsPath, streamId });
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.status).toBe("dispatched");

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0, pollIntervalMs: 1 });
    expect(result.status).toBe("blocked_on_merges");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.status).toBe("landed");
    expect(stream?.reviewCycles).toBe(1);
    expect(stream?.prUrl).toBe(PR_URL);
    // The stream already carried a prUrl before the poll, so the draft→ready
    // flip is skipped entirely.
    expect(gh.markReadyCalls).toHaveLength(0);
  });

  test("call at maxCycles refuses cycle-exhausted and writes one escalation row", async () => {
    const { runId, streamId } = landedSeed({ reviewCycles: 3 });
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await expectRefusal(
      () =>
        address({ clock: () => 0, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      "cycle-exhausted",
    );
    expect(fake.calls.some((c) => c.kind === "startShip")).toBe(false);
    const rows = store.listEscalations({ class: "cycle-exhausted", driverRunId: runId });
    expect(rows).toHaveLength(1);

    // A second call dedups on the open row (still one).
    await expectRefusal(
      () =>
        address({ clock: () => 0, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      "cycle-exhausted",
    );
    expect(store.listEscalations({ class: "cycle-exhausted", driverRunId: runId })).toHaveLength(1);
    // The row was untouched by the refusal.
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.reviewCycles).toBe(3);
  });

  test.each([
    ["not-landed", { status: "dispatched" as const }],
    ["not-cloud", { runtime: "local", branch: "feat-a", status: "landed", prUrl: PR_URL }],
    ["no-pr", { prUrl: undefined, branch: undefined }],
    ["no-pr", { prUrl: PR_URL, branch: undefined }],
  ])("refuses %s and leaves the stream row untouched", async (code, over) => {
    const { runId, streamId } = landedSeed(over as SeedOpts);
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await expectRefusal(
      () =>
        address({ clock: () => 0, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      code as AddressError["code"],
    );
    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.reviewCycles).toBeUndefined();
    expect(fake.calls.some((c) => c.kind === "startShip")).toBe(false);
  });

  test("refuses pr-not-open when the PR is merged or closed", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "MERGED" } });

    await expectRefusal(
      () =>
        address({ clock: () => 0, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      "pr-not-open",
    );
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.reviewCycles).toBeUndefined();
  });

  test("refuses findings-unreadable for a missing or empty findings file", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });

    await expectRefusal(
      () =>
        address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
          findingsPath: join(repoRoot, "nope.md"),
          streamId,
        }),
      "findings-unreadable",
    );

    writeFileSync(findingsPath, "   \n");
    await expectRefusal(
      () =>
        address({ clock: () => 0, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      "findings-unreadable",
    );
    expect(store.getDriverRun(runId)?.batches[0]?.streams[0]?.reviewCycles).toBeUndefined();
  });

  test("refuses an over-limit findings file as findings-unreadable", async () => {
    const { runId, streamId } = landedSeed();
    const fake = createFakeShipPort([]);
    const gh = createFakeGhPort({ 77: { state: "OPEN" } });
    writeFileSync(findingsPath, "x".repeat(1024 * 1024 + 1));

    await expectRefusal(
      () => address({ gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      "findings-unreadable",
    );
    expect(fake.calls.some((call) => call.kind === "startShip")).toBe(false);
  });

  describe("stale-head re-validation at attempt start", () => {
    const NEW_HEAD = `aaaa${"0".repeat(36)}`;

    test("parks stream and does not dispatch when head advances between consumption and fresh address dispatch", async () => {
      const { runId, streamId } = landedSeed();
      const fake = createFakeShipPort([]);
      // First viewPullRequest (loadAddressPr) returns HEAD_SHA; second
      // (checkAddressAttemptHead inside dispatchAddress) returns NEW_HEAD.
      let viewCount = 0;
      const baseGh = createFakeGhPort({ 77: { state: "OPEN", headRefOid: HEAD_SHA } });
      const gh = {
        ...baseGh,
        viewPullRequest(repo: string, prNumber: number) {
          viewCount++;
          if (viewCount >= 2) {
            return Promise.resolve({
              headRefOid: NEW_HEAD,
              mergeCommit: null as null,
              mergedAt: null as null,
              state: "OPEN" as const,
            });
          }
          return baseGh.viewPullRequest(repo, prNumber);
        },
      };

      await expect(
        address({ clock: () => 0, gh, ship: fake.port, store }, runId, { findingsPath, streamId }),
      ).rejects.toThrow(/consumed head does not match/);

      const stream = firstStream(runId);
      expect(stream?.status).toBe("failed");
      expect(stream?.errorMessage).toMatch(/stale-head/);
      // Consumption committed; the cycle was claimed.
      expect(stream?.reviewCycles).toBe(1);
      expect(store.getDriverRun(runId)?.status).toBe("awaiting_judgment");
      expect(fake.calls.some((c) => c.kind === "startShip")).toBe(false);
    });

    test("dispatches normally when head is unchanged at fresh address dispatch", async () => {
      const { runId, streamId } = landedSeed();
      const fake = createFakeShipPort([]);
      const gh = createFakeGhPort({ 77: { state: "OPEN", headRefOid: HEAD_SHA } });

      await address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
        findingsPath,
        streamId,
      });

      expect(firstStream(runId)?.status).toBe("dispatched");
      expect(fake.calls.some((c) => c.kind === "startShip")).toBe(true);
    });

    test("parks stream on tick re-dispatch when head has moved (covers recovery and retry paths)", async () => {
      const { runId, streamId } = landedSeed();
      // Initial address dispatch succeeds with matching head.
      const fake = createFakeShipPort([]);
      const ghInitial = createFakeGhPort({ 77: { state: "OPEN", headRefOid: HEAD_SHA } });
      await address({ clock: () => 0, gh: ghInitial, ship: fake.port, store }, runId, {
        findingsPath,
        streamId,
      });
      expect(firstStream(runId)?.status).toBe("dispatched");

      // Simulate recovery reset: stream is back to pending (as if dispatching recovery
      // found 0 candidates and reset, or decide retry reset it).
      store.updateDriverStream(streamId, {
        dispatchModel: null,
        dispatchModelParams: null,
        dispatchProvider: null,
        effortDegraded: false,
        status: "pending",
        tierDegradeReason: null,
      });
      store.updateDriverRunStatus(runId, "running");

      // Tick with head advanced: stale-head guard should park the stream.
      const ghStale = createFakeGhPort({ 77: { state: "OPEN", headRefOid: NEW_HEAD } });
      const driver = createDriverService({ clock: () => 0, gh: ghStale, ship: fake.port, store });
      const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0, pollIntervalMs: 1 });

      expect(result.status).toBe("awaiting_judgment");
      const stream = firstStream(runId);
      expect(stream?.status).toBe("failed");
      expect(stream?.errorMessage).toMatch(/stale-head/);
      // reviewCycles is preserved from the consumed artifact.
      expect(stream?.reviewCycles).toBe(1);
      // No new dispatch attempt was made.
      const startCalls = fake.calls.filter((c) => c.kind === "startShip");
      expect(startCalls).toHaveLength(1); // only the initial dispatch
    });

    test("head unchanged on tick re-dispatch proceeds normally", async () => {
      const { runId, streamId } = landedSeed();
      const digest = canonicalReviewFindingsSha256(parseReviewFindings(validFindingsArtifact()));
      const synthesizedDoc = join(repoRoot, `address-${streamId}-cycle1-${digest.slice(0, 12)}.md`);
      const fake = createFakeShipPort([
        {
          branchName: "feat-a",
          docPath: synthesizedDoc,
          prUrl: PR_URL,
          repo: "ship",
          workflowRunId: "wf_retry",
        },
      ]);
      const gh = createFakeGhPort({ 77: { state: "OPEN", headRefOid: HEAD_SHA } });
      await address({ clock: () => 0, gh, ship: fake.port, store }, runId, {
        findingsPath,
        streamId,
      });

      // Simulate recovery/retry reset.
      store.updateDriverStream(streamId, {
        dispatchModel: null,
        dispatchModelParams: null,
        dispatchProvider: null,
        effortDegraded: false,
        status: "pending",
        tierDegradeReason: null,
      });
      store.updateDriverRunStatus(runId, "running");

      const driver = createDriverService({ clock: () => 0, gh, ship: fake.port, store });
      const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0, pollIntervalMs: 1 });

      // Head unchanged → second dispatch succeeds → stream lands.
      expect(result.status).toBe("blocked_on_merges");
      expect(firstStream(runId)?.status).toBe("landed");
    });

    test("decide retry after stale-head park with head still moved parks again", async () => {
      const { runId, streamId } = landedSeed();
      const fakeInitial = createFakeShipPort([]);
      const ghInitial = createFakeGhPort({ 77: { state: "OPEN", headRefOid: HEAD_SHA } });
      await address({ clock: () => 0, gh: ghInitial, ship: fakeInitial.port, store }, runId, {
        findingsPath,
        streamId,
      });

      // Reset to pending to simulate recovery/retry.
      store.updateDriverStream(streamId, {
        dispatchModel: null,
        dispatchModelParams: null,
        dispatchProvider: null,
        effortDegraded: false,
        status: "pending",
        tierDegradeReason: null,
      });
      store.updateDriverRunStatus(runId, "running");

      // Tick: stale head parks the stream.
      const fakeRetry = createFakeShipPort([]);
      const ghStale = createFakeGhPort({ 77: { state: "OPEN", headRefOid: NEW_HEAD } });
      const driver = createDriverService({
        clock: () => 0,
        gh: ghStale,
        ship: fakeRetry.port,
        store,
      });
      await driver.run({ driverRunId: runId }, { maxWaitMs: 0, pollIntervalMs: 1 });
      expect(firstStream(runId)?.status).toBe("failed");
      expect(store.getDriverRun(runId)?.status).toBe("awaiting_judgment");

      // decide retry: stream back to pending.
      driver.decide(runId, streamId, { kind: "retry" });
      expect(firstStream(runId)?.status).toBe("pending");

      // Another tick with head still moved → parks again.
      const result2 = await driver.run({ driverRunId: runId }, { maxWaitMs: 0, pollIntervalMs: 1 });
      expect(result2.status).toBe("awaiting_judgment");
      expect(firstStream(runId)?.status).toBe("failed");
      expect(firstStream(runId)?.errorMessage).toMatch(/stale-head/);
      expect(fakeRetry.calls.some((c) => c.kind === "startShip")).toBe(false);
    });
  });
});

async function expectRefusal(
  fn: () => Promise<unknown>,
  code: AddressError["code"],
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AddressError);
    expect((err as AddressError).code).toBe(code);
    return;
  }
  throw new Error(`expected AddressError(${code}) but call resolved`);
}

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

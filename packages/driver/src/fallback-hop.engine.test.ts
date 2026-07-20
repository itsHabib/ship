/**
 * Engine e2e (fake runners) for dispatch-fallback P2a — both seams.
 */

import { createStore } from "@ship/store";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveDocPath } from "./engine.js";
import { createDriverService } from "./service.js";
import { createFakeShipPort } from "./test/fake-ship-port.js";

describe("engine fallback hop (P2a)", () => {
  let tmpDir: string;
  let repoRoot: string;
  let prevAnthropic: string | undefined;
  let prevClaudeOauth: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fallback-engine-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, "docs", "tasks"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "tasks", "a.md"), "# task a\n");
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });

    prevAnthropic = process.env["ANTHROPIC_API_KEY"];
    prevClaudeOauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "test-oauth";
  });

  afterEach(() => {
    if (prevAnthropic === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = prevAnthropic;
    if (prevClaudeOauth === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = prevClaudeOauth;
    rmSync(tmpDir, { force: true, recursive: true });
  });

  function writeCloudFallbackManifest(extraStreamLines: string[] = []): string {
    const path = join(repoRoot, "fallback.driver.md");
    writeFileSync(
      path,
      `---
driver_version: 1
generated_at: 2026-07-13T00:00:00Z
generated_by: test
source:
  project: ship
  phase: fallback-hop
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: cloud
        provider: cursor
        status: pending
        fallback:
          - runtime: local
            provider: claude
${extraStreamLines.map((l) => `        ${l}`).join("\n")}
---
`,
    );
    return path;
  }

  test("sync throw → hop → completes on local/claude with zero decide", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const localDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/tasks/a.md",
    );
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        repo: "ship",
        throwOnStart: new Error("boom"),
        workflowRunId: "wf_cloud",
      },
      { docPath: localDoc, repo: "ship", workflowRunId: "wf_local" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");
    expect(result.awaiting).toHaveLength(0);

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("local");
    expect(stream?.provider).toBe("claude");
    expect(stream?.fallbackCursor).toBe(1);
    expect(stream?.fallbackLog).toHaveLength(1);
    expect(stream?.fallbackLog?.[0] && "from" in stream.fallbackLog[0]).toBe(true);
    store.close();
  });

  test("async pre-work gateway-auth → hop at poll seam", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const localDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/tasks/a.md",
    );
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        failureCategory: "gateway-auth",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_cloud",
      },
      { docPath: localDoc, repo: "ship", workflowRunId: "wf_local" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");
    expect(result.awaiting).toHaveLength(0);

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("local");
    expect(stream?.provider).toBe("claude");
    expect(stream?.fallbackLog?.[0]).toMatchObject({ category: "gateway-auth" });
    store.close();
  });

  test("work-carrying stream (reviewCycles > 0) + eligible category does not hop (sync)", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        repo: "ship",
        throwOnStart: new Error("boom"),
        workflowRunId: "wf_cloud",
      },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;
    const streamId = store.getDriverRun(runId)!.batches[0]!.streams[0]!.id;
    store.updateDriverStream(streamId, {
      prUrl: "https://github.com/example/ship/pull/9",
      reviewCycles: 1,
    });

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("awaiting_judgment");
    expect(result.awaiting[0]?.kind).toBe("failure-triage");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("cloud");
    expect(stream?.provider).toBe("cursor");
    expect(stream?.fallbackCursor).toBe(0);
    expect(stream?.fallbackLog).toEqual([]);
    store.close();
  });

  test("work-carrying + eligible does not hop at poll seam", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        failureCategory: "gateway-auth",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_cloud",
      },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;
    const streamId = store.getDriverRun(runId)!.batches[0]!.streams[0]!.id;
    store.updateDriverStream(streamId, {
      prUrl: "https://github.com/example/ship/pull/9",
      reviewCycles: 2,
    });

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("awaiting_judgment");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("cloud");
    expect(stream?.fallbackLog).toEqual([]);
    store.close();
  });

  test("poll-seam PR on a failed run blocks the hop AND persists to the stream row", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        failureCategory: "gateway-auth",
        prUrl: "https://github.com/example/ship/pull/12",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_cloud",
      },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("awaiting_judgment");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("cloud");
    expect(stream?.fallbackCursor ?? 0).toBe(0);
    // The workflow's PR is now a stored fact — later stored-column readers
    // (sync seam, breaker predicate, decide retry) see the work products.
    expect(stream?.prUrl).toBe("https://github.com/example/ship/pull/12");
    store.close();
  });

  test("multi-hop: two chain entries, first throws, second succeeds", async () => {
    const path = join(repoRoot, "multi-hop.driver.md");
    writeFileSync(
      path,
      `---
driver_version: 1
generated_at: 2026-07-13T00:00:00Z
generated_by: test
source:
  project: ship
  phase: fallback-multi
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: cloud
        provider: cursor
        status: pending
        fallback:
          - runtime: cloud
            provider: claude
          - runtime: local
            provider: claude
---
`,
    );
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const localDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/tasks/a.md",
    );
    const fake = createFakeShipPort([
      { docPath: cloudDoc, repo: "ship", throwOnStart: new Error("primary"), workflowRunId: "wf1" },
      // After hop to cloud/claude, doc path is still the cloud root doc.
      { docPath: cloudDoc, repo: "ship", throwOnStart: new Error("second"), workflowRunId: "wf2" },
      { docPath: localDoc, repo: "ship", workflowRunId: "wf3" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(path).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("local");
    expect(stream?.provider).toBe("claude");
    expect(stream?.fallbackCursor).toBe(2);
    expect(stream?.fallbackLog?.filter((r) => "from" in r)).toHaveLength(2);
    store.close();
  });

  test("exhaustion escalates once with derived failed: line; no dispatch-failing row", async () => {
    const path = join(repoRoot, "exhaust.driver.md");
    writeFileSync(path, exhaustManifestYaml());
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const localDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/tasks/a.md",
    );
    const fake = createFakeShipPort([
      { docPath: cloudDoc, repo: "ship", throwOnStart: new Error("primary"), workflowRunId: "wf1" },
      {
        docPath: localDoc,
        repo: "ship",
        throwOnStart: new Error("fallback"),
        workflowRunId: "wf2",
      },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(path).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expectExhaustionEscalation(store, runId, result);

    // decide retry → fail again → exactly one new park escalation, no re-walk
    const triage = result.awaiting[0];
    if (triage?.kind !== "failure-triage") throw new Error("expected failure-triage");
    driver.decide(runId, triage.streamId, { kind: "retry" });
    const again = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(again.status).toBe("awaiting_judgment");
    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.fallbackCursor).toBe(1);
    expect(stream?.fallbackLog?.filter((r) => "from" in r)).toHaveLength(1);

    const parkedAfter = store.listEscalations({ class: "stream-parked", driverRunId: runId });
    expect(parkedAfter.length).toBeGreaterThanOrEqual(2);
    store.close();
  });

  test("ineligible category (logic) does not hop", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        failureCategory: "logic",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_cloud",
      },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("awaiting_judgment");
    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("cloud");
    expect(stream?.fallbackCursor).toBe(0);
    expect(stream?.fallbackLog).toEqual([]);
    store.close();
  });

  test("sync transient blip → one retry → succeeds on same target", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        repo: "ship",
        throwOnStart: new Error("connect ETIMEDOUT"),
        workflowRunId: "wf_blip",
      },
      { docPath: cloudDoc, repo: "ship", workflowRunId: "wf_ok" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("cloud");
    expect(stream?.provider).toBe("cursor");
    expect(stream?.fallbackCursor).toBe(0);
    expect(stream?.fallbackLog).toEqual([
      expect.objectContaining({
        retried: { provider: "cursor", runtime: "cloud" },
        reason: "sdk-throw",
      }),
    ]);
    const starts = fake.calls.filter((c) => c.kind === "startShip");
    expect(starts).toHaveLength(2);
    store.close();
  });

  test("sync transient retry then advance on second failure", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const localDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/tasks/a.md",
    );
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        repo: "ship",
        throwOnStart: new Error("connect ETIMEDOUT"),
        workflowRunId: "wf1",
      },
      {
        docPath: cloudDoc,
        repo: "ship",
        throwOnStart: new Error("connect ETIMEDOUT"),
        workflowRunId: "wf2",
      },
      { docPath: localDoc, repo: "ship", workflowRunId: "wf3" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("local");
    expect(stream?.provider).toBe("claude");
    expect(stream?.fallbackCursor).toBe(1);
    expect(stream?.fallbackLog?.filter((r) => "retried" in r)).toHaveLength(1);
    expect(stream?.fallbackLog?.filter((r) => "from" in r)).toHaveLength(1);
    store.close();
  });

  test("poll-seam contention → one retry → succeed", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        failureCategory: "contention",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf_busy",
      },
      { docPath: cloudDoc, repo: "ship", workflowRunId: "wf_ok" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("cloud");
    expect(stream?.fallbackCursor).toBe(0);
    expect(stream?.fallbackLog?.[0]).toMatchObject({
      retried: { provider: "cursor", runtime: "cloud" },
      reason: "contention",
    });
    store.close();
  });

  test("poll-seam contention retry then second failure advances when eligible", async () => {
    const manifest = writeCloudFallbackManifest();
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const localDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/tasks/a.md",
    );
    const fake = createFakeShipPort([
      {
        docPath: cloudDoc,
        failureCategory: "contention",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf1",
      },
      {
        docPath: cloudDoc,
        failureCategory: "gateway-auth",
        repo: "ship",
        terminalStatus: "failed",
        workflowRunId: "wf2",
      },
      { docPath: localDoc, repo: "ship", workflowRunId: "wf3" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.runtime).toBe("local");
    expect(stream?.fallbackCursor).toBe(1);
    expect(stream?.fallbackLog?.filter((r) => "retried" in r)).toHaveLength(1);
    expect(stream?.fallbackLog?.filter((r) => "from" in r)).toHaveLength(1);
    store.close();
  });

  test("cross-provider hop records resolved fromModel/toModel (tier-mapped, no pin)", async () => {
    const path = join(repoRoot, "models.driver.md");
    writeFileSync(
      path,
      `---
driver_version: 1
generated_at: 2026-07-13T00:00:00Z
generated_by: test
source:
  project: ship
  phase: fallback-models
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: cloud
        provider: cursor
        model: opus
        status: pending
        fallback:
          - runtime: local
            provider: claude
---
`,
    );
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const localDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/tasks/a.md",
    );
    const fake = createFakeShipPort([
      { docPath: cloudDoc, repo: "ship", throwOnStart: new Error("boom"), workflowRunId: "wf1" },
      { docPath: localDoc, repo: "ship", workflowRunId: "wf2" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(path).run.id;

    const result = await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });
    expect(result.status).toBe("blocked_on_merges");

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    const hop = stream?.fallbackLog?.find((r) => "from" in r);
    expect(hop).toMatchObject({
      fromModel: "claude-opus-4-8",
      toModel: "claude-opus-4-8",
    });
    store.close();
  });

  test("cross-provider hop records pinned model_id as toModel", async () => {
    const path = join(repoRoot, "pinned.driver.md");
    writeFileSync(
      path,
      `---
driver_version: 1
generated_at: 2026-07-13T00:00:00Z
generated_by: test
source:
  project: ship
  phase: fallback-pinned
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: cloud
        provider: cursor
        model: sonnet
        status: pending
        fallback:
          - runtime: local
            provider: claude
            model_id: claude-haiku-4-5
---
`,
    );
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const localDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/tasks/a.md",
    );
    const fake = createFakeShipPort([
      { docPath: cloudDoc, repo: "ship", throwOnStart: new Error("boom"), workflowRunId: "wf1" },
      { docPath: localDoc, repo: "ship", workflowRunId: "wf2" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(path).run.id;

    await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });

    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    expect(stream?.modelId).toBe("claude-haiku-4-5");
    expect(stream?.fallbackLog?.[0]).toMatchObject({
      fromModel: "composer-2.5",
      toModel: "claude-haiku-4-5",
    });
    const localStart = fake.calls
      .filter((c) => c.kind === "startShip")
      .map((c) => c.input as { model?: string; docPath?: string })
      .find((i) => i.docPath === localDoc);
    expect(localStart?.model).toBe("claude-haiku-4-5");
    store.close();
  });

  test("hop to a saturated runtime stays pending — caps hold across the redispatch", async () => {
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-b"), { recursive: true });
    const path = join(repoRoot, "caps.driver.md");
    writeFileSync(
      path,
      `---
driver_version: 1
generated_at: 2026-07-13T00:00:00Z
generated_by: test
source:
  project: ship
  phase: fallback-caps
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/b.md
        branch_name: feat-b
        runtime: local
        provider: claude
        status: pending
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: cloud
        provider: cursor
        status: pending
        fallback:
          - runtime: local
            provider: claude
---
`,
    );
    const slotHolderDoc = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-b"),
      "docs/tasks/b.md",
    );
    const cloudDoc = resolveDocPath(repoRoot, "docs/tasks/a.md");
    const fake = createFakeShipPort([
      // Occupies the single local slot for the whole tick (never terminal).
      { docPath: slotHolderDoc, repo: "ship", terminalStatus: "running", workflowRunId: "wf_slot" },
      { docPath: cloudDoc, repo: "ship", throwOnStart: new Error("boom"), workflowRunId: "wf_c" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: fake.port, store });
    const runId = driver.importManifest(path).run.id;

    await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });

    const streams = store.getDriverRun(runId)?.batches[0]?.streams;
    const hopped = streams?.[1];
    // The hop rewrote the target, but with maxParallelLocal (default 1) held by
    // the slot stream, the redispatch waits for a later tick.
    expect(hopped?.runtime).toBe("local");
    expect(hopped?.status).toBe("pending");
    expect(hopped?.fallbackCursor).toBe(1);
    const startedDocs = fake.calls
      .filter((c) => c.kind === "startShip")
      .map((c) => (c.input as { docPath?: string }).docPath);
    expect(startedDocs).toHaveLength(2);
    expect(startedDocs).toContain(slotHolderDoc);
    expect(startedDocs).toContain(cloudDoc);
    store.close();
  });
});

function exhaustManifestYaml(): string {
  return `---
driver_version: 1
generated_at: 2026-07-13T00:00:00Z
generated_by: test
source:
  project: ship
  phase: fallback-exhaust
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        branch_name: feat-a
        runtime: cloud
        provider: cursor
        status: pending
        fallback:
          - runtime: local
            provider: claude
---
`;
}

function expectExhaustionEscalation(
  store: ReturnType<typeof createStore>,
  runId: string,
  result: { status: string; awaiting: unknown[] },
): void {
  expect(result.status).toBe("awaiting_judgment");
  expect(result.awaiting).toHaveLength(1);
  const parked = store.listEscalations({ class: "stream-parked", driverRunId: runId });
  expect(parked).toHaveLength(1);
  expect(parked[0]?.payloadJson).toMatch(/dispatch failed after fallback/);
  expect(parked[0]?.payloadJson).toMatch(/failed: sdk-throw on local\/claude/);
  expect(parked[0]?.payloadJson).toMatch(/bare decide retry re-fires local\/claude/);
  expect(store.listEscalations({ class: "dispatch-failing", driverRunId: runId })).toHaveLength(0);
}

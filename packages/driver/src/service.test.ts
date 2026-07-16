/** Service surface and error-path coverage. */

import { createStore, newDriverRunId } from "@ship/store";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveDocPath } from "./engine.js";
import { DriverRunNotFoundEngineError } from "./errors.js";
import { createDriverService } from "./service.js";
import { createFakeShipPort } from "./test/fake-ship-port.js";

describe("driver service", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "driver-service-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("run resolves manifestPath ref via import", async () => {
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "task.md"), "# task\n");

    const manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T00:00:00Z
generated_by: test
source:
  project: ship
  phase: svc
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/task.md
        branch_name: feat-a
        runtime: local
        status: done
---
`,
    );

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const result = await driver.run({ manifestPath }, { maxWaitMs: 0 });
    expect(result.status).toBe("done");
    store.close();
  });

  test("run throws DriverRunNotFoundEngineError for unknown id", async () => {
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    await expect(driver.run({ driverRunId: "drv_missing" }, { maxWaitMs: 0 })).rejects.toThrow(
      DriverRunNotFoundEngineError,
    );
    store.close();
  });

  test("run refreshes orphaned cloud runs; read verbs do not", async () => {
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "task.md"), "# task\n");

    const manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T00:00:00Z
generated_by: test
source:
  project: ship
  phase: svc
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/task.md
        branch_name: feat-a
        runtime: local
        status: done
---
`,
    );

    const store = createStore({ dbPath: ":memory:" });
    const { port, calls } = createFakeShipPort([]);
    const driver = createDriverService({ ship: port, store });
    const imported = driver.importManifest(manifestPath);

    // Read verbs must not sweep — that was the #137 read/write-separation point.
    driver.render(imported.run.id);
    driver.getDriverRun(imported.run.id);
    expect(calls.some((c) => c.kind === "refreshOrphanedRuns")).toBe(false);

    // A tick owns orphan recovery — via the non-streaming refresh, not the
    // streaming resume (which the mcp-server keeps for its long-lived sweep).
    await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });
    expect(calls.some((c) => c.kind === "refreshOrphanedRuns")).toBe(true);
    store.close();
  });

  test("run tolerates a port without refreshOrphanedRuns", async () => {
    const store = createStore({ dbPath: ":memory:" });
    const { port } = createFakeShipPort([]);
    // Omit the optional method entirely (exactOptionalPropertyTypes forbids
    // an explicit `undefined`) — the run path must tolerate its absence.
    const { refreshOrphanedRuns: _omit, ...portWithoutRefresh } = port;
    const driver = createDriverService({ ship: portWithoutRefresh, store });
    const manifestPath = join(tmpDir, "norefresh.driver.md");
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T00:00:00Z
generated_by: test
source:
  project: ship
  phase: svc
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/task.md
        branch_name: feat-a
        runtime: local
        status: done
---
`,
    );
    const imported = driver.importManifest(manifestPath);
    const result = await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });
    expect(result.status).toBe("done");
    store.close();
  });

  test("run auto-import surfaces manifest warnings on the tick result", async () => {
    const repoRoot = join(tmpDir, "repo-warn");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-06-12T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: svc",
        "repo: ship",
        "base_branch: main",
        "batches: []",
        "---",
      ].join("\n"),
    );

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const result = await driver.run({ manifestPath }, { maxWaitMs: 0 });
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes('unknown field "base_branch"'))).toBe(true);
    store.close();
  });

  test("run by driverRunId does not carry import warnings", async () => {
    const repoRoot = join(tmpDir, "repo-resume");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-06-12T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: svc",
        "repo: ship",
        "base_branch: main",
        "batches: []",
        "---",
      ].join("\n"),
    );

    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const imported = driver.importManifest(manifestPath);
    const result = await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });
    expect(result.warnings).toBeUndefined();
    store.close();
  });

  test("startShip throw marks stream failed and continues tick", async () => {
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, ".claude", "worktrees", "feat-a"), { recursive: true });
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "task.md"), "# task\n");

    const manifestPath = join(repoRoot, "driver.md");
    writeFileSync(
      manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T00:00:00Z
generated_by: test
source:
  project: ship
  phase: svc
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

    const docPath = resolveDocPath(
      join(repoRoot, ".claude", "worktrees", "feat-a"),
      "docs/task.md",
    );
    const { port } = createFakeShipPort([
      { docPath, repo: "ship", throwOnStart: new Error("dispatch blew up"), workflowRunId: "wf_x" },
    ]);
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: port, store });
    const imported = driver.importManifest(manifestPath);
    const result = await driver.run({ driverRunId: imported.run.id }, { maxWaitMs: 0 });
    expect(result.status).toBe("awaiting_judgment");
    store.close();
  });

  test("deleteDriverRun returns the deleted run and removes it from the store", () => {
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    const runId = newDriverRunId();
    store.insertDriverRun({
      batches: [],
      id: runId,
      manifestPath: join(tmpDir, "driver.md"),
      phase: "svc",
      project: "ship",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const deleted = driver.deleteDriverRun(runId);
    expect(deleted.id).toBe(runId);
    expect(store.getDriverRun(runId)).toBeNull();
    store.close();
  });

  test("deleteDriverRun throws DriverRunNotFoundEngineError for an unknown id", () => {
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ ship: createFakeShipPort([]).port, store });
    expect(() => driver.deleteDriverRun(newDriverRunId())).toThrow(DriverRunNotFoundEngineError);
    store.close();
  });
});

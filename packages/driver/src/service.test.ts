/** Service surface and error-path coverage. */

import { createStore } from "@ship/store";
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
});

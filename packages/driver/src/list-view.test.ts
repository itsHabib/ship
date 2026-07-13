/** Tests for the driver list projection (`buildDriverListEnvelope`). */

import type { DriverRun } from "@ship/store";

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildDriverListEnvelope, type DriverListEnvelope } from "./list-view.js";

const FORBIDDEN_RUN_KEYS = new Set([
  "sourceJson",
  "manifestPath",
  "id",
  "tickStartedAt",
  "tickEndedAt",
]);
const FORBIDDEN_STREAM_KEYS = new Set(["driverBatchId", "driverRunId", "workOnCurrentBranch"]);
const FORBIDDEN_ATTEMPT_KEYS = new Set(["docPath"]);

function assertRunKeysSafe(run: DriverListEnvelope["runs"][number]): void {
  for (const key of Object.keys(run)) {
    expect(FORBIDDEN_RUN_KEYS.has(key), `forbidden run key: ${key}`).toBe(false);
  }
}

function assertStreamKeysSafe(
  stream: DriverListEnvelope["runs"][number]["batches"][number]["streams"][number],
): void {
  for (const key of Object.keys(stream)) {
    expect(FORBIDDEN_STREAM_KEYS.has(key), `forbidden stream key: ${key}`).toBe(false);
  }
  for (const attempt of stream.attempts) {
    for (const key of Object.keys(attempt)) {
      expect(FORBIDDEN_ATTEMPT_KEYS.has(key), `forbidden attempt key: ${key}`).toBe(false);
    }
  }
}

function assertNoForbiddenKeys(envelope: DriverListEnvelope): void {
  for (const run of envelope.runs) {
    assertRunKeysSafe(run);
    for (const batch of run.batches) {
      expect(Object.keys(batch)).not.toContain("driverRunId");
      for (const stream of batch.streams) {
        assertStreamKeysSafe(stream);
      }
    }
  }
  expect(JSON.stringify(envelope)).not.toContain("sourceJson");
}

describe("buildDriverListEnvelope", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "driver-list-view-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("empty input returns versioned envelope with empty runs", () => {
    expect(buildDriverListEnvelope([])).toEqual({ runs: [], v: 1 });
  });

  test("excludes sourceJson, absolute manifestPath, and attempt docPath", () => {
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const manifestPath = join(repoRoot, "docs", "driver.md");
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    const sourceJson = `---
driver_version: 1
generated_at: 2026-06-12T00:00:00.000Z
generated_by: test
source:
  project: ship
  phase: list-view
repo: ship
batches: []
---
`;
    writeFileSync(manifestPath, sourceJson);

    const run: DriverRun = {
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          driverRunId: "drv_01",
          id: "db_01",
          status: "pending",
          streams: [
            {
              attempts: [
                {
                  dispatchedAt: "2026-06-12T00:00:00.000Z",
                  docPath: "/abs/path/docs/task.md",
                  failureCategory: "logic",
                  terminal: true,
                  workflowRunId: "wf_01",
                },
              ],
              createdAt: "2026-06-12T00:00:00.000Z",
              driverBatchId: "db_01",
              driverRunId: "drv_01",
              id: "ds_01",
              runtime: "local",
              specPath: "/abs/path/docs/task.md",
              status: "failed",
              streamIndex: 0,
              taskSlug: "task-a",
              touches: ["src/a.ts", "C:\\secret\\a.ts"],
              updatedAt: "2026-06-12T00:00:00.000Z",
            },
          ],
        },
      ],
      createdAt: "2026-06-12T00:00:00.000Z",
      id: "drv_01",
      manifestPath,
      phase: "list-view",
      project: "ship",
      repo: "ship",
      sourceJson,
      status: "pending",
      updatedAt: "2026-06-12T00:00:00.000Z",
    };

    const envelope = buildDriverListEnvelope([run]);
    assertNoForbiddenKeys(envelope);
    const projected = envelope.runs[0]!;
    const stream = projected.batches[0]!.streams[0]!;
    expect(projected.sourceHash).toBe(
      createHash("sha256").update(sourceJson, "utf8").digest("hex"),
    );
    expect(projected.manifestRef).toBe("docs/driver.md");
    expect(stream.specPath).toBe("[path]");
    expect(stream.touches).toEqual(["src/a.ts", "[path]"]);
    expect(stream.attempts[0]).toEqual({
      dispatchedAt: "2026-06-12T00:00:00.000Z",
      failureCategory: "logic",
      terminal: true,
      workflowRunId: "wf_01",
    });
  });

  test("omits manifestRef when the path is outside the repo root", () => {
    const run: DriverRun = {
      batches: [],
      createdAt: "2026-06-12T00:00:00.000Z",
      id: "drv_02",
      manifestPath: "/tmp/no-git/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
      updatedAt: "2026-06-12T00:00:00.000Z",
    };
    expect(buildDriverListEnvelope([run]).runs[0]?.manifestRef).toBeUndefined();
  });

  test("omits dispatch telemetry for pending streams", () => {
    const run: DriverRun = {
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          driverRunId: "drv_03",
          id: "db_03",
          status: "pending",
          streams: [
            {
              attempts: [],
              createdAt: "2026-06-12T00:00:00.000Z",
              dispatchModel: "should-not-copy",
              dispatchProvider: "cursor",
              driverBatchId: "db_03",
              driverRunId: "drv_03",
              id: "ds_03",
              modelTier: "sonnet",
              provider: "cursor",
              runtime: "local",
              specPath: "docs/task.md",
              status: "pending",
              streamIndex: 0,
              touches: [],
              updatedAt: "2026-06-12T00:00:00.000Z",
            },
          ],
        },
      ],
      createdAt: "2026-06-12T00:00:00.000Z",
      id: "drv_03",
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
      updatedAt: "2026-06-12T00:00:00.000Z",
    };
    const stream = buildDriverListEnvelope([run]).runs[0]?.batches[0]?.streams[0];
    expect(stream?.provider).toBe("cursor");
    expect(stream?.modelTier).toBe("sonnet");
    expect(stream?.dispatchProvider).toBeUndefined();
    expect(stream?.dispatchModel).toBeUndefined();
  });

  test("redacts absolute paths from errorMessage", () => {
    const run: DriverRun = {
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          driverRunId: "drv_05",
          id: "db_05",
          status: "failed",
          streams: [
            {
              attempts: [],
              createdAt: "2026-06-12T00:00:00.000Z",
              driverBatchId: "db_05",
              driverRunId: "drv_05",
              errorMessage:
                "ENOENT open '/abs/repo/task.md'; failed for C:\\Program Files\\Ship\\task.md then /var/log/ship",
              id: "ds_05",
              runtime: "local",
              specPath: "docs/task.md",
              status: "failed",
              streamIndex: 0,
              touches: [],
              updatedAt: "2026-06-12T00:00:00.000Z",
            },
          ],
        },
      ],
      createdAt: "2026-06-12T00:00:00.000Z",
      id: "drv_05",
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "failed",
      updatedAt: "2026-06-12T00:00:00.000Z",
    };
    const stream = buildDriverListEnvelope([run]).runs[0]?.batches[0]?.streams[0];
    expect(stream?.errorMessage).toBe("ENOENT open [path]; failed for [path]");
    const serialized = JSON.stringify(buildDriverListEnvelope([run]));
    expect(serialized).not.toMatch(/\/abs\/repo|\/var\/log|[A-Z]:\\\\/);
  });

  test("includes dispatch telemetry for non-pending streams", () => {
    const run: DriverRun = {
      batches: [
        {
          batchIndex: 1,
          dependsOn: [1],
          driverRunId: "drv_04",
          id: "db_04",
          status: "running",
          streams: [
            {
              attempts: [],
              createdAt: "2026-06-12T00:00:00.000Z",
              dispatchModel: "gpt-4",
              dispatchModelParams: [{ id: "thinking", value: "high" }],
              dispatchProvider: "cursor",
              driverBatchId: "db_04",
              driverRunId: "drv_04",
              id: "ds_04",
              runtime: "cloud",
              specPath: "docs/task.md",
              status: "dispatched",
              streamIndex: 0,
              touches: ["src/driver.ts"],
              updatedAt: "2026-06-12T00:00:00.000Z",
            },
          ],
        },
      ],
      createdAt: "2026-06-12T00:00:00.000Z",
      id: "drv_04",
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "running",
      updatedAt: "2026-06-12T00:00:00.000Z",
    };
    const batch = buildDriverListEnvelope([run]).runs[0]!.batches[0]!;
    const stream = batch.streams[0]!;
    const sourceBatch = run.batches[0]!;
    const sourceStream = sourceBatch.streams[0]!;
    expect(stream.dispatchProvider).toBe("cursor");
    expect(stream.dispatchModel).toBe("gpt-4");
    expect(batch.dependsOn).not.toBe(sourceBatch.dependsOn);
    expect(stream.touches).not.toBe(sourceStream.touches);
    expect(stream.dispatchModelParams).not.toBe(sourceStream.dispatchModelParams);
    expect(stream.dispatchModelParams![0]).not.toBe(sourceStream.dispatchModelParams![0]);
  });
});

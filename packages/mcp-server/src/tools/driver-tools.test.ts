/**
 * `driver_*` tool tests — schema boundary + happy paths on real disk.
 */

import type { DriverService } from "@ship/driver";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDefaultShipService } from "@ship/core";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { writeOneStreamManifest } from "../../../cli/test/driver-fixtures.js";
import { expectToolError, parseToolJson } from "../../test/mcp-harness.js";
import { createMcpDriverServiceFactory } from "../driver-service.js";
import { buildServer } from "../server.js";

interface DriverMcpHarness {
  client: Client;
  driver: DriverService;
  cursor: FakeCursorRunner;
  tmp: string;
  repoRoot: string;
  close: () => Promise<void>;
}

async function createDriverMcpHarness(): Promise<DriverMcpHarness> {
  const tmp = mkdtempSync(join(tmpdir(), "driver-mcp-disk-"));
  const dbPath = join(tmp, "state.db");
  const runsDir = join(tmp, "runs");
  const repoRoot = join(tmp, "repo");
  const cursor = new FakeCursorRunner();
  const opts = { dbPath, runsDir, cursor };
  const shipFactory = createDefaultShipService(opts);
  const driverFactory = createMcpDriverServiceFactory(opts, shipFactory);
  const driver = driverFactory();
  const server = buildServer(shipFactory, driverFactory);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "driver-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    driver,
    cursor,
    tmp,
    repoRoot,
    close: async () => {
      await client.close();
      await server.close();
      await shipFactory().drainBackground();
    },
  };
}

let h: DriverMcpHarness;

beforeEach(async () => {
  h = await createDriverMcpHarness();
});

afterEach(async () => {
  await h.close();
  rmSync(h.tmp, { force: true, recursive: true });
});

describe("driver MCP tools", () => {
  test("driver_run defaults maxWaitMs to 0 and returns after one pass", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
      delayMsBetweenEvents: 60_000,
    });
    const imported = h.driver.importManifest(layout.manifestPath);
    const raw = await h.client.callTool({
      name: "driver_run",
      arguments: { driverRunId: imported.run.id },
    });
    const result = parseToolJson(raw) as { status: string; streams: { status: string }[] };
    expect(result.status).toBe("running");
    expect(result.streams.some((s) => s.status === "dispatched")).toBe(true);
  });

  test("driver_status returns manifestModified when frontmatter drifted", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    const imported = h.driver.importManifest(layout.manifestPath);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      layout.manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T10:00:00Z
generated_by: test-edited
source:
  project: ship
  phase: driver-cli-test
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
    const raw = await h.client.callTool({
      name: "driver_status",
      arguments: { driverRunId: imported.run.id },
    });
    const status = parseToolJson(raw) as { manifestModified?: true };
    expect(status.manifestModified).toBe(true);
  });

  test("driver_run accepts manifestPath with batch pollIntervalMs and force", async () => {
    const layout = writeOneStreamManifest(h.repoRoot, { batchCount: 2 });
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const raw = await h.client.callTool({
      name: "driver_run",
      arguments: {
        manifestPath: layout.manifestPath,
        batch: 1,
        pollIntervalMs: 1_000,
        force: true,
        maxWaitMs: 5_000,
      },
    });
    const result = parseToolJson(raw) as { streams: { batchIndex: number; status: string }[] };
    const batch2 = result.streams.filter((s) => s.batchIndex === 2);
    expect(batch2.every((s) => s.status === "pending")).toBe(true);
  }, 15_000);

  test("driver_status returns not found for unknown driverRunId", async () => {
    const raw = await h.client.callTool({
      name: "driver_status",
      arguments: { driverRunId: "drv_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    const { text } = expectToolError(raw);
    expect(text).toMatch(/not found/i);
  });

  test("driver_status omits manifestModified when manifest file is deleted", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    const imported = h.driver.importManifest(layout.manifestPath);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(layout.manifestPath);
    const raw = await h.client.callTool({
      name: "driver_status",
      arguments: { driverRunId: imported.run.id },
    });
    const status = parseToolJson(raw) as { manifestModified?: true };
    expect(status.manifestModified).toBeUndefined();
  });

  test("driver_decide maps engine errors to invalid params", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    const imported = h.driver.importManifest(layout.manifestPath);
    const raw = await h.client.callTool({
      name: "driver_decide",
      arguments: {
        driverRunId: imported.run.id,
        streamId: "ds_unknown",
        decision: { kind: "retry" },
      },
    });
    const { text } = expectToolError(raw);
    expect(text.length).toBeGreaterThan(0);
  });

  test("driver_decide retry returns updated run status", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "failed", durationMs: 0, branches: [] },
    });
    const imported = h.driver.importManifest(layout.manifestPath);
    const tick = await h.driver.run(
      { driverRunId: imported.run.id },
      { maxWaitMs: 5_000, pollIntervalMs: 1_000 },
    );
    const triage = tick.awaiting[0];
    if (triage?.kind !== "failure-triage") throw new Error("expected triage");
    const raw = await h.client.callTool({
      name: "driver_decide",
      arguments: {
        driverRunId: imported.run.id,
        streamId: triage.streamId,
        decision: { kind: "retry" },
      },
    });
    const out = parseToolJson(raw) as { status: string };
    expect(out.status).toBe("running");
  }, 15_000);
});

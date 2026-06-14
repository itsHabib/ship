/**
 * Fake-cursor driver CLI integration — five acceptance scenarios (P4).
 * Real temp-dir SQLite + real ShipService + scripted FakeCursorRunner.
 */

import type { Command } from "commander";

import { closeDefaultSharedStore } from "@ship/core";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CliExit } from "../../packages/cli/src/errors.js";
import { buildProgram } from "../../packages/cli/src/program.js";
import { createCliDriverService, createCliService } from "../../packages/cli/src/service.js";
import { writeOneStreamManifest } from "../../packages/cli/test/driver-fixtures.js";

const RUN_TO_LAND = ["--max-wait", "30s", "--poll-interval", "1s"] as const;
const RUN_TO_TRIAGE = ["--max-wait", "5s", "--poll-interval", "1s"] as const;
const RUN_QUICK = ["--max-wait", "0s"] as const;

interface DriverHarness {
  program: Command;
  cursor: FakeCursorRunner;
  tmp: string;
  repoRoot: string;
  /** Closes the shared store, then removes the temp dir — Windows cannot unlink an open SQLite file. */
  dispose: () => void;
}

function createDriverHarness(): DriverHarness {
  const tmp = mkdtempSync(join(tmpdir(), "driver-e2e-"));
  const dbPath = join(tmp, "state.db");
  const runsDir = join(tmp, "runs");
  const repoRoot = join(tmp, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const cursor = new FakeCursorRunner();
  const opts = { dbPath, runsDir, cursor, cloudCursor: cursor };
  const shipFactory = createCliService(opts);
  const program = buildProgram(shipFactory, createCliDriverService(opts));
  const dispose = (): void => {
    closeDefaultSharedStore(dbPath);
    rmSync(tmp, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  };
  return { program, cursor, tmp, repoRoot, dispose };
}

async function runDriver(
  program: Command,
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  let code = 0;
  try {
    await program.parseAsync(["node", "ship", ...argv]);
  } catch (err) {
    if (err instanceof CliExit) code = err.code;
    else throw err;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

let h: DriverHarness;

beforeEach(() => {
  h = createDriverHarness();
});

afterEach(() => {
  h.dispose();
});

describe("driver CLI fake-cursor e2e", () => {
  test("scenario 1: N=1 happy path → blocked_on_merges → mark-merged → done", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const first = await runDriver(h.program, [
      "driver",
      "run",
      layout.manifestPath,
      ...RUN_TO_LAND,
      "--json",
    ]);
    expect(first.code).toBe(0);
    const tick1 = JSON.parse(first.stdout.trim()) as {
      status: string;
      driverRunId: string;
      unmerged: { streamId: string }[];
    };
    expect(tick1.status).toBe("blocked_on_merges");
    expect(tick1.unmerged).toHaveLength(1);

    await runDriver(h.program, [
      "driver",
      "mark-merged",
      tick1.driverRunId,
      "--stream",
      tick1.unmerged[0]!.streamId,
      "--pr",
      "1",
      "--sha",
      "abc123",
    ]);

    const second = await runDriver(h.program, [
      "driver",
      "run",
      tick1.driverRunId,
      ...RUN_QUICK,
      "--json",
    ]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout.trim()) as { status: string }).toMatchObject({
      status: "done",
    });
  }, 60_000);

  test("scenario 2: --batch 1 leaves batch 2 untouched", async () => {
    const layout = writeOneStreamManifest(h.repoRoot, { batchCount: 2 });
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const out = await runDriver(h.program, [
      "driver",
      "run",
      layout.manifestPath,
      "--batch",
      "1",
      ...RUN_TO_LAND,
      "--json",
    ]);
    expect(out.code).toBe(0);
    const tick = JSON.parse(out.stdout.trim()) as {
      streams: { batchIndex: number; status: string }[];
    };
    const batch2 = tick.streams.filter((s) => s.batchIndex === 2);
    expect(batch2.every((s) => s.status === "pending")).toBe(true);
  }, 60_000);

  test("scenario 3: failed-retry → exit 10 → decide retry → success", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "failed", durationMs: 0, branches: [] },
    });
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const failed = await runDriver(h.program, [
      "driver",
      "run",
      layout.manifestPath,
      ...RUN_TO_TRIAGE,
      "--json",
    ]);
    expect(failed.code).toBe(10);
    const triage = JSON.parse(failed.stdout.trim()) as {
      driverRunId: string;
      awaiting: { kind: string; streamId: string }[];
    };
    expect(triage.awaiting[0]?.kind).toBe("failure-triage");

    await runDriver(h.program, [
      "driver",
      "decide",
      triage.driverRunId,
      "retry",
      "--stream",
      triage.awaiting[0]!.streamId,
    ]);

    await runDriver(h.program, ["driver", "run", triage.driverRunId, ...RUN_TO_LAND, "--json"]);

    const status = JSON.parse(
      (
        await runDriver(h.program, ["driver", "status", triage.driverRunId, "--json"])
      ).stdout.trim(),
    ) as { batches: { streams: { attempts: unknown[] }[] }[] };
    expect(status.batches[0]?.streams[0]?.attempts.length).toBe(2);
  }, 60_000);

  test("scenario 4: store-only resume after manifest delete + render --out", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const first = await runDriver(h.program, [
      "driver",
      "run",
      layout.manifestPath,
      ...RUN_TO_LAND,
      "--json",
    ]);
    const tick1 = JSON.parse(first.stdout.trim()) as {
      driverRunId: string;
      unmerged: { streamId: string }[];
    };
    unlinkSync(layout.manifestPath);
    await runDriver(h.program, [
      "driver",
      "mark-merged",
      tick1.driverRunId,
      "--stream",
      tick1.unmerged[0]!.streamId,
      "--pr",
      "2",
      "--sha",
      "def456",
    ]);
    const outPath = join(h.repoRoot, "regenerated.driver.md");
    await runDriver(h.program, ["driver", "render", tick1.driverRunId, "--out", outPath]);
    expect(statSync(outPath).isFile()).toBe(true);

    const done = await runDriver(h.program, [
      "driver",
      "run",
      tick1.driverRunId,
      ...RUN_QUICK,
      "--json",
    ]);
    expect(JSON.parse(done.stdout.trim()) as { status: string }).toMatchObject({ status: "done" });
  }, 60_000);

  test("scenario 5: cancel mid-flight is sticky on re-run", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
      delayMsBetweenEvents: 60_000,
    });
    const imported = await runDriver(h.program, ["driver", "import", layout.manifestPath]);
    const { driverRunId } = JSON.parse(imported.stdout.trim()) as { driverRunId: string };

    await runDriver(h.program, [
      "driver",
      "run",
      driverRunId,
      ...RUN_QUICK,
      "--poll-interval",
      "1s",
    ]);

    const cancelled = await runDriver(h.program, ["driver", "cancel", driverRunId]);
    expect(cancelled.code).toBe(0);

    const again = await runDriver(h.program, [
      "driver",
      "run",
      driverRunId,
      ...RUN_QUICK,
      "--json",
    ]);
    expect(JSON.parse(again.stdout.trim()) as { status: string }).toMatchObject({
      status: "cancelled",
    });
  });
});

/**
 * Tests for the store-scoped single-instance guard. A real temp registry dir
 * plus a deterministic {@link ProcessInspector} and injected clock let us pin
 * the reap policy without spawning processes.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ProcessInspector } from "./single-instance.js";

import {
  awaitPidsGone,
  heartbeatInstance,
  INSTANCE_FRESHNESS_MS,
  reconcileSingleInstance,
  registryDirFor,
  releaseInstance,
} from "./single-instance.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ship-instances-"));
  dbPath = join(tmpDir, "state.db");
});

afterEach(() => {
  rmSync(tmpDir, { force: true, recursive: true });
});

const NOW = Date.parse("2026-07-23T22:00:00.000Z");

// A ship-server-looking command line (contains both "ship" and "mcp-server").
const SHIP_CMDLINE = "node C:/Users/x/pers/ship/packages/mcp-server/src/bin.ts";

function fakeInspector(
  alivePids: Set<number>,
  cmdlines?: Map<number, string | undefined>,
): ProcessInspector & { terminated: number[] } {
  const terminated: number[] = [];
  return {
    terminated,
    isAlive: (pid) => alivePids.has(pid),
    terminate: (pid) => {
      terminated.push(pid);
      alivePids.delete(pid);
    },
    // Default: every live pid looks like a ship server, so the existing reap
    // cases still reap. Per-pid overrides drive the identity-gate tests.
    commandLine: (pid) => (cmdlines?.has(pid) ? cmdlines.get(pid) : SHIP_CMDLINE),
  };
}

function seedEntry(pid: number, heartbeatMs: number): void {
  const dir = registryDirFor(dbPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${String(pid)}.json`),
    JSON.stringify({
      pid,
      startedAt: new Date(heartbeatMs).toISOString(),
      heartbeatAt: new Date(heartbeatMs).toISOString(),
      dbPath,
    }),
  );
}

function writeRaw(pid: number, contents: string): void {
  writeFileSync(join(registryDirFor(dbPath), `${String(pid)}.json`), contents);
}

describe("reconcileSingleInstance", () => {
  test("empty registry: registers self, reaps nothing", () => {
    const inspector = fakeInspector(new Set());
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(result.reapedPids).toEqual([]);
    expect(existsSync(result.selfEntryPath)).toBe(true);
    const entry = JSON.parse(readFileSync(result.selfEntryPath, "utf8")) as { pid: number };
    expect(entry.pid).toBe(1000);
    expect(inspector.terminated).toEqual([]);
  });

  test("live + fresh sibling is reaped (last-one-wins) and its entry removed", () => {
    seedEntry(2000, NOW - 10_000); // 10s old heartbeat → fresh
    const inspector = fakeInspector(new Set([2000]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(result.reapedPids).toEqual([2000]);
    expect(inspector.terminated).toEqual([2000]);
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(false);
    expect(existsSync(result.selfEntryPath)).toBe(true);
  });

  test("dead sibling entry is swept without a kill", () => {
    seedEntry(2000, NOW - 10_000);
    const inspector = fakeInspector(new Set()); // pid 2000 not alive
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(result.reapedPids).toEqual([]);
    expect(result.removedStalePids).toEqual([2000]);
    expect(inspector.terminated).toEqual([]);
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(false);
  });

  test("fresh entry whose PID was reused by a non-ship process is swept, not killed", () => {
    seedEntry(2000, NOW - 10_000); // fresh heartbeat
    // PID 2000 is alive but its command line is some unrelated process.
    const inspector = fakeInspector(new Set([2000]), new Map([[2000, "C:/Windows/explorer.exe"]]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(inspector.terminated).toEqual([]); // never killed the innocent process
    expect(result.reapedPids).toEqual([]);
    expect(result.removedStalePids).toEqual([2000]); // stale entry cleaned up
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(false);
  });

  test("fresh entry whose identity cannot be read is left untouched (fail-safe)", () => {
    seedEntry(2000, NOW - 10_000); // fresh heartbeat
    const inspector = fakeInspector(new Set([2000]), new Map([[2000, undefined]]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(inspector.terminated).toEqual([]);
    expect(result.reapedPids).toEqual([]);
    // Unconfirmable → we neither kill nor delete; leave it for the operator.
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(true);
  });

  test("alive but stale-heartbeat entry is left untouched (PID-reuse guard)", () => {
    seedEntry(2000, NOW - (INSTANCE_FRESHNESS_MS + 60_000)); // well past freshness
    const inspector = fakeInspector(new Set([2000]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(result.reapedPids).toEqual([]);
    expect(inspector.terminated).toEqual([]);
    // The suspect entry is NOT killed and NOT removed — left for the operator.
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(true);
  });

  test("garbage entry file is removed, never terminated", () => {
    mkdirSync(registryDirFor(dbPath), { recursive: true });
    writeRaw(3000, "{ not valid json");
    const inspector = fakeInspector(new Set([3000]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(inspector.terminated).toEqual([]);
    expect(existsSync(join(registryDirFor(dbPath), "3000.json"))).toBe(false);
    expect(result.reapedPids).toEqual([]);
  });

  test("a stale self entry from a prior run is skipped, not reaped", () => {
    seedEntry(1000, NOW - (INSTANCE_FRESHNESS_MS + 60_000)); // same pid as self
    const inspector = fakeInspector(new Set([1000]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(inspector.terminated).toEqual([]);
    expect(result.reapedPids).toEqual([]);
    // self entry is (re)written fresh
    const entry = JSON.parse(readFileSync(result.selfEntryPath, "utf8")) as { heartbeatAt: string };
    expect(Date.parse(entry.heartbeatAt)).toBe(NOW);
  });
});

describe("heartbeatInstance / releaseInstance", () => {
  test("heartbeat advances heartbeatAt; release removes the entry", () => {
    const inspector = fakeInspector(new Set());
    const { selfEntryPath } = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });

    heartbeatInstance(selfEntryPath, NOW + 90_000);
    const after = JSON.parse(readFileSync(selfEntryPath, "utf8")) as { heartbeatAt: string };
    expect(Date.parse(after.heartbeatAt)).toBe(NOW + 90_000);

    releaseInstance(selfEntryPath);
    expect(existsSync(selfEntryPath)).toBe(false);
    // Release is idempotent.
    expect(() => {
      releaseInstance(selfEntryPath);
    }).not.toThrow();
  });

  test("heartbeat on a missing entry is a no-op (does not recreate it)", () => {
    const path = join(registryDirFor(dbPath), "9999.json");
    reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector: fakeInspector(new Set()),
    });
    heartbeatInstance(path, NOW + 1000);
    expect(existsSync(path)).toBe(false);
  });
});

describe("awaitPidsGone", () => {
  test("returns [] immediately when every pid is already gone", async () => {
    const remaining = await awaitPidsGone([1, 2], { isAlive: () => false });
    expect(remaining).toEqual([]);
  });

  test("waits across polls until the pid dies, then returns []", async () => {
    let clock = 0;
    const sleep = (ms: number): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    };
    let checks = 0;
    const inspector = {
      isAlive: (): boolean => {
        checks += 1;
        return checks <= 2; // alive for the first two probes, then gone
      },
    };
    const remaining = await awaitPidsGone([7], inspector, {
      sleep,
      nowMs: () => clock,
      timeoutMs: 3_000,
      intervalMs: 50,
    });
    expect(remaining).toEqual([]);
  });

  test("returns the still-alive pids once the timeout elapses", async () => {
    let clock = 0;
    const sleep = (ms: number): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    };
    const remaining = await awaitPidsGone(
      [9],
      { isAlive: () => true },
      {
        sleep,
        nowMs: () => clock,
        timeoutMs: 200,
        intervalMs: 50,
      },
    );
    expect(remaining).toEqual([9]);
  });
});

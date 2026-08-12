/**
 * Tests for the store-scoped single-instance guard. A real temp registry dir
 * plus a deterministic {@link ProcessInspector} and injected clock let us pin
 * the reap policy without spawning processes.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ProcessInspector } from "./single-instance.js";

import {
  awaitPidsGone,
  canonicalStorePath,
  heartbeatInstance,
  INSTANCE_FRESHNESS_MS,
  reconcileSingleInstance,
  registryDirFor,
  releaseInstance,
  systemProcessInspector,
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
  parents?: Map<number, number | undefined>,
): ProcessInspector & { terminated: number[] } {
  const terminated: number[] = [];
  return {
    terminated,
    isAlive: (pid) => alivePids.has(pid),
    identity: (pid) => (alivePids.has(pid) ? `birth-${String(pid)}` : undefined),
    terminate: (pid) => {
      terminated.push(pid);
      alivePids.delete(pid);
    },
    // Default: every live pid looks like a ship server, so the existing reap
    // cases still reap. Per-pid overrides drive the identity-gate tests.
    commandLine: (pid) => (cmdlines?.has(pid) ? cmdlines.get(pid) : SHIP_CMDLINE),
    // Default: every sibling reads as ORPHANED (re-parented to init), so reap
    // cases reap. Per-pid overrides drive the healthy-peer tests.
    parentPid: (pid) => (parents?.has(pid) ? parents.get(pid) : 1),
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
  test("the system inspector exposes a stable identity for the current process", () => {
    const first = systemProcessInspector.identity(process.pid);
    const second = systemProcessInspector.identity(process.pid);

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

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

  test("two aliases of one store share a canonical identity", () => {
    const alias = `${dirname(dbPath)}${sep}.${sep}${basename(dbPath)}`;
    expect(canonicalStorePath(alias)).toBe(canonicalStorePath(dbPath));
  });

  test("a database-file symlink resolves to the physical store identity", () => {
    writeFileSync(dbPath, "sqlite placeholder");
    const alias = join(tmpDir, "current.db");
    try {
      symlinkSync(dbPath, alias, "file");
    } catch (err: unknown) {
      // Windows runners can deny file-symlink creation without Developer Mode.
      // The platform-neutral path alias test above still runs there; exercise
      // filename-symlink behavior everywhere the OS permits the fixture.
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    expect(canonicalStorePath(alias)).toBe(canonicalStorePath(dbPath));
  });

  test("a healthy sibling with a live client is a peer: coexist, never reap", () => {
    seedEntry(2000, NOW - 10_000); // fresh heartbeat
    const alive = new Set([2000, 500]); // 500 = the sibling's live client
    const inspector = fakeInspector(alive, undefined, new Map([[2000, 500]]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(result.reapedPids).toEqual([]);
    expect(inspector.terminated).toEqual([]);
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(true);
    expect(existsSync(result.selfEntryPath)).toBe(true);
  });

  test("an unreadable parent fails safe: coexist, never reap", () => {
    seedEntry(2000, NOW - 10_000);
    const inspector = fakeInspector(new Set([2000]), undefined, new Map([[2000, undefined]]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(result.reapedPids).toEqual([]);
    expect(inspector.terminated).toEqual([]);
  });

  test("a dead recorded parent proves orphanhood when termination is graceful", () => {
    // Parent 600 is NOT in the alive set. The explicit capability keeps this
    // policy test platform-neutral even when CI itself runs on Windows.
    seedEntry(2000, NOW - 10_000);
    const inspector = fakeInspector(new Set([2000]), undefined, new Map([[2000, 600]]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
      terminateIsGraceful: true,
    });
    expect(result.reapedPids).toEqual([2000]);
    expect(inspector.terminated).toEqual([2000]);
  });

  test("a Windows-style hard termination never reaps an orphan with active local work", () => {
    seedEntry(2000, NOW - 10_000);
    const inspector = fakeInspector(new Set([2000]), undefined, new Map([[2000, 600]]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
      terminateIsGraceful: false,
    });

    expect(result.reapedPids).toEqual([]);
    expect(inspector.terminated).toEqual([]);
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(true);
  });

  test("an orphaned sibling is reaped, entry kept until its exit is confirmed", () => {
    seedEntry(2000, NOW - 10_000); // 10s old heartbeat → fresh; default parent = init (orphan)
    const inspector = fakeInspector(new Set([2000]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
      terminateIsGraceful: true,
    });
    expect(result.reapedPids).toEqual([2000]);
    expect(inspector.terminated).toEqual([2000]);
    // The entry survives the reconcile: the caller removes it only once the
    // pid is confirmed gone. A hung sibling's heartbeat never recreates a
    // missing entry, so deleting here would make it permanently invisible.
    // reconcile derives the registry from the CANONICAL store path (on macOS
    // the tmpdir crosses the /var → /private/var symlink), so the reported
    // entryPath is the canonical spelling.
    const entryPath = join(registryDirFor(canonicalStorePath(dbPath)), "2000.json");
    expect(existsSync(entryPath)).toBe(true);
    expect(result.reapedEntries).toEqual([{ pid: 2000, entryPath }]);
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

  test("fresh entry whose PID looks unrelated is neither killed nor swept", () => {
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
    // An unrecognized command line is evidence of PID reuse, not proof of it —
    // it is equally the signature of a launch path this matcher doesn't know.
    // Since reconcile opens the store regardless, deleting the entry would drop
    // the only record of a sibling that may still hold the WAL. Keep it: one
    // stale file is cheaper than two writers on one database.
    expect(result.removedStalePids).toEqual([]);
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(true);
  });

  test("a source-run sibling is not reaped on argv evidence, and keeps its entry", () => {
    seedEntry(2000, NOW - 10_000); // fresh heartbeat
    // The command line the documented source run produces: the package
    // directory is the cwd, so it appears nowhere in argv — no "mcp-server",
    // and here not even "ship". This IS a live sibling and ideally would be
    // reaped, but nothing in this string distinguishes it from any other
    // project's `tsx … bin.ts`, and matching on that would SIGTERM a stranger
    // whose PID happened to collide. Decline, and keep the entry so the
    // sibling stays visible instead of being silently erased.
    const sourceRun = "node /tmp/build/node_modules/tsx/dist/cli.mjs src/bin.ts";
    const inspector = fakeInspector(new Set([2000]), new Map([[2000, sourceRun]]));
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(inspector.terminated).toEqual([]);
    expect(result.reapedPids).toEqual([]);
    expect(result.removedStalePids).toEqual([]);
    expect(existsSync(join(registryDirFor(dbPath), "2000.json"))).toBe(true);
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

  test("an entry for a different SHIP_DB_PATH in the same dir is left untouched (store scoping)", () => {
    const dir = registryDirFor(dbPath);
    mkdirSync(dir, { recursive: true });
    const otherDbPath = join(tmpDir, "other.db"); // same dir, different store
    writeFileSync(
      join(dir, "2000.json"),
      JSON.stringify({
        pid: 2000,
        startedAt: new Date(NOW - 10_000).toISOString(),
        heartbeatAt: new Date(NOW - 10_000).toISOString(),
        dbPath: otherDbPath,
      }),
    );
    const inspector = fakeInspector(new Set([2000])); // alive + fresh
    const result = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    expect(inspector.terminated).toEqual([]); // never reaps another store's server
    expect(result.reapedPids).toEqual([]);
    expect(existsSync(join(dir, "2000.json"))).toBe(true); // and leaves its entry alone
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

  test("entry writes are atomic: no .tmp scratch survives, and the entry always parses", () => {
    const inspector = fakeInspector(new Set());
    const { selfEntryPath } = reconcileSingleInstance({
      dbPath,
      selfPid: 1000,
      startedAtMs: NOW,
      nowMs: NOW,
      inspector,
    });
    heartbeatInstance(selfEntryPath, NOW + 5_000);
    // Temp-then-rename means a reader can never observe a truncated entry —
    // a partial read classified as garbage would sweep a live server.
    const leftovers = readdirSync(registryDirFor(dbPath)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(() => {
      JSON.parse(readFileSync(selfEntryPath, "utf8"));
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

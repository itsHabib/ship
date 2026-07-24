/**
 * Store-scoped single-instance guard for `@ship/mcp-server`.
 *
 * Why this exists: every Claude session spawns its own `@ship/mcp-server`
 * process, and before the lifecycle wiring in `bin.ts` those servers never
 * exited when their session died — on Windows a dirty parent death delivers no
 * stdin EOF, so orphaned servers accumulated (6 alive at once, over hours) all
 * holding one `state.db` open. Unbounded long-lived writers on a single WAL
 * file is what rotted the b-tree twice, with total data loss.
 *
 * The design already treats the mcp-server as a *single* long-lived,
 * dispatch-capable process whose boot adopts a prior server's orphaned runs
 * (see `docs/.../multi-process-store-guard.md` — `resumeOrphans`). This guard
 * completes that handover: a fresh server reaps the prior server(s) bound to
 * the SAME store, then registers itself. Short-lived CLI processes never
 * register here, so the intended CLI+server concurrency is untouched.
 *
 * Liveness is decided by a heartbeat the running server refreshes on a timer —
 * NOT by PID alone. A reaped-and-reused PID therefore reads as stale-heartbeat
 * and is never terminated; only a genuinely-live sibling ship server (fresh
 * heartbeat) is reaped. This is the PID-reuse guard.
 *
 * This module is pure mechanism + a small policy (which siblings to reap). The
 * process primitives are injected via {@link ProcessInspector} so the policy is
 * unit-testable without spawning real processes.
 */

import type { Logger } from "@ship/logger";

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Registry subdirectory under the store dir; one JSON file per live server. */
const REGISTRY_DIRNAME = "mcp-server-instances";

/**
 * A registry entry is "fresh" (its owner is a genuinely-live ship server) if
 * its heartbeat is newer than this. Kept a small multiple of the heartbeat
 * cadence so a dead server's entry goes stale quickly, shrinking the window in
 * which a reused PID could be mistaken for a live sibling.
 */
export const INSTANCE_FRESHNESS_MS = 150_000;

/** How often a running server should refresh its heartbeat (see bin.ts timer). */
export const INSTANCE_HEARTBEAT_MS = 60_000;

/**
 * How long to wait for a reaped sibling to actually exit before opening the
 * store. `process.kill` returns before the OS finishes tearing the process
 * down; on Windows the killed holder's WAL `-shm` handle lingers just long
 * enough that an immediate reopen faults with a transient "disk I/O error".
 * Waiting for the PID to disappear closes that race.
 */
export const PID_EXIT_TIMEOUT_MS = 3_000;

/** On-disk shape of a registry entry. */
interface InstanceEntry {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  dbPath: string;
}

/**
 * Injected process primitives — the mechanism the reap policy drives. The
 * default implementation ({@link systemProcessInspector}) uses `process.kill`;
 * tests substitute a deterministic fake.
 */
export interface ProcessInspector {
  /** True when a process with `pid` currently exists. */
  isAlive: (pid: number) => boolean;
  /** Ask `pid` to terminate (SIGTERM → graceful on POSIX; hard on Windows). */
  terminate: (pid: number) => void;
}

/** Options for {@link reconcileSingleInstance}. */
export interface ReconcileOptions {
  /** The resolved SQLite path — its directory scopes the registry. */
  dbPath: string;
  /** This process's pid (`process.pid`). */
  selfPid: number;
  /** This process's start time in epoch ms. */
  startedAtMs: number;
  /** Current time in epoch ms (injectable for tests). */
  nowMs: number;
  inspector: ProcessInspector;
  logger?: Logger;
  /** Freshness window override (tests); defaults to {@link INSTANCE_FRESHNESS_MS}. */
  freshnessMs?: number;
}

/** Outcome of a reconcile pass. */
export interface ReconcileResult {
  /** Absolute path of this process's own registry entry. */
  selfEntryPath: string;
  /** Pids of live sibling servers this pass terminated (last-one-wins). */
  reapedPids: number[];
  /** Pids whose entries were dead/garbage and were swept away without a kill. */
  removedStalePids: number[];
}

/** Registry directory for the store that `dbPath` lives in. */
export function registryDirFor(dbPath: string): string {
  return join(dirname(dbPath), REGISTRY_DIRNAME);
}

/**
 * The default {@link ProcessInspector}. `isAlive` uses signal 0 (existence
 * probe): `ESRCH` → gone; `EPERM` → exists but not ours (still alive). Both
 * `terminate` and the probe swallow "already gone" so reconcile stays robust
 * against a sibling exiting mid-pass.
 */
export const systemProcessInspector: ProcessInspector = {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  terminate(pid: number): void {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone, or not permitted — nothing to reap.
    }
  },
};

/**
 * Ensure this process is the only live ship server bound to `dbPath`'s store,
 * then register it. Reaps live sibling servers (last-one-wins) and sweeps away
 * dead / garbage entries. Never throws on a single bad entry — a corrupt or
 * racing entry is logged and skipped so a fresh server always comes up.
 */
export function reconcileSingleInstance(opts: ReconcileOptions): ReconcileResult {
  const freshnessMs = opts.freshnessMs ?? INSTANCE_FRESHNESS_MS;
  const dir = registryDirFor(opts.dbPath);
  mkdirSync(dir, { recursive: true });

  const reapedPids: number[] = [];
  const removedStalePids: number[] = [];
  for (const file of listEntryFiles(dir)) {
    const path = join(dir, file);
    const action = classifyEntry(path, opts, freshnessMs);
    if (action.kind === "skip") continue;
    if (action.kind === "remove") {
      removeEntry(path);
      removedStalePids.push(action.pid);
      continue;
    }
    opts.inspector.terminate(action.pid);
    removeEntry(path);
    reapedPids.push(action.pid);
    opts.logger?.warn(
      { reapedPid: action.pid, dbPath: opts.dbPath },
      "reaped a live sibling ship mcp-server bound to the same store (single-instance, last-one-wins)",
    );
  }

  const selfEntryPath = join(dir, `${String(opts.selfPid)}.json`);
  writeEntry(selfEntryPath, {
    pid: opts.selfPid,
    startedAt: new Date(opts.startedAtMs).toISOString(),
    heartbeatAt: new Date(opts.nowMs).toISOString(),
    dbPath: opts.dbPath,
  });
  return { selfEntryPath, reapedPids, removedStalePids };
}

/** Options for {@link awaitPidsGone} (all injectable for tests). */
export interface AwaitPidsGoneOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

/**
 * Poll until every pid in `pids` has exited, or `timeoutMs` elapses. Returns
 * the pids still alive at the deadline (empty when all are gone). Callers open
 * the store only after this resolves so they never reopen a WAL file whose
 * just-reaped holder hasn't finished releasing it.
 */
export async function awaitPidsGone(
  pids: readonly number[],
  inspector: Pick<ProcessInspector, "isAlive">,
  opts: AwaitPidsGoneOptions = {},
): Promise<number[]> {
  const timeoutMs = opts.timeoutMs ?? PID_EXIT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? 50;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.nowMs ?? (() => Date.now());

  const deadline = now() + timeoutMs;
  let remaining = pids.filter((pid) => inspector.isAlive(pid));
  while (remaining.length > 0 && now() < deadline) {
    await sleep(intervalMs);
    remaining = remaining.filter((pid) => inspector.isAlive(pid));
  }
  return remaining;
}

/** Refresh this process's heartbeat so live siblings can tell it apart from a reused PID. */
export function heartbeatInstance(selfEntryPath: string, nowMs: number): void {
  const entry = readEntry(selfEntryPath);
  if (entry === undefined) return;
  entry.heartbeatAt = new Date(nowMs).toISOString();
  writeEntry(selfEntryPath, entry);
}

/** Remove this process's registry entry on graceful shutdown. Idempotent. */
export function releaseInstance(selfEntryPath: string): void {
  removeEntry(selfEntryPath);
}

type EntryAction =
  | { kind: "skip" }
  | { kind: "remove"; pid: number }
  | { kind: "reap"; pid: number };

/**
 * Decide what to do with one sibling entry. Policy: reap only a live sibling
 * with a fresh heartbeat (a real running ship server); remove dead or garbage
 * entries without a kill; leave an alive-but-stale-heartbeat entry untouched
 * (a hung server or a reused PID — not safe to kill, log for the operator).
 */
function classifyEntry(path: string, opts: ReconcileOptions, freshnessMs: number): EntryAction {
  const entry = readEntry(path);
  if (entry === undefined) {
    opts.logger?.warn({ path }, "removing unreadable ship mcp-server registry entry");
    return { kind: "remove", pid: Number.NaN };
  }
  if (entry.pid === opts.selfPid) return { kind: "skip" };
  if (!opts.inspector.isAlive(entry.pid)) return { kind: "remove", pid: entry.pid };

  const heartbeatMs = Date.parse(entry.heartbeatAt);
  const fresh = Number.isFinite(heartbeatMs) && opts.nowMs - heartbeatMs <= freshnessMs;
  if (fresh) return { kind: "reap", pid: entry.pid };

  opts.logger?.warn(
    { pid: entry.pid, heartbeatAt: entry.heartbeatAt },
    "alive ship mcp-server registry entry has a stale heartbeat; not reaping (possible hung server or reused PID)",
  );
  return { kind: "skip" };
}

function listEntryFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

function readEntry(path: string): InstanceEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstanceEntry>;
    if (typeof parsed.pid !== "number" || typeof parsed.heartbeatAt !== "string") return undefined;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : parsed.heartbeatAt,
      heartbeatAt: parsed.heartbeatAt,
      dbPath: typeof parsed.dbPath === "string" ? parsed.dbPath : "",
    };
  } catch {
    return undefined;
  }
}

function writeEntry(path: string, entry: InstanceEntry): void {
  writeFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

function removeEntry(path: string): void {
  rmSync(path, { force: true });
}

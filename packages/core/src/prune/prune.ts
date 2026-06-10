/**
 * Terminal-run artifact hygiene — pure selection logic plus execution
 * against the store and runs directory.
 */

import type { Store, WorkflowRunPruneRow } from "@ship/store";

import { isTerminal, type WorkflowStatus } from "@ship/workflow";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const DURATION_PATTERN = /^(\d+)([dhwm])$/;

export class PruneDurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PruneDurationError";
  }
}

export interface PruneTarget {
  readonly runId: string;
  readonly status: WorkflowStatus | "orphan";
  readonly updatedAt?: string;
  readonly ageMs: number;
  readonly deleteStoreRow: boolean;
  readonly deleteRunDir: boolean;
}

export interface PruneRunsInput {
  readonly before: string;
  readonly dryRun?: boolean;
}

export interface PruneRunsOutput {
  readonly dryRun: boolean;
  readonly targets: readonly PruneTarget[];
  readonly deletedStoreRows: number;
  readonly deletedRunDirs: number;
  /** Run ids whose deletion failed or was skipped by the orphan recheck — never aborts the batch. */
  readonly failures: readonly string[];
}

export interface PruneFs {
  listRunDirNames(runsDir: string): Promise<string[]>;
  removeRunDir(path: string): Promise<void>;
}

export function createNodePruneFs(): PruneFs {
  return {
    listRunDirNames: async (runsDir) => {
      try {
        const entries = await readdir(runsDir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return [];
        throw err;
      }
    },
    removeRunDir: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Parse a duration like `30d`, `12h`, `2w`, `45m` into milliseconds. */
export function parsePruneDuration(raw: string): number {
  const trimmed = raw.trim();
  const match = DURATION_PATTERN.exec(trimmed);
  if (match === null) {
    throw new PruneDurationError(`invalid --before duration: ${raw}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (amount <= 0) {
    throw new PruneDurationError(`invalid --before duration: ${raw}`);
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (unit === "d") return amount * dayMs;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "w") return amount * 7 * dayMs;
  return amount * 60 * 1000;
}

export function computePruneCutoffMs(before: string, nowMs: number): number {
  return nowMs - parsePruneDuration(before);
}

/**
 * Pure selection over store rows + on-disk run dirs. Pending/running rows
 * are never selected; terminal rows older than the cutoff are; orphan dirs
 * (no store row) are always selected.
 */
export function selectPruneTargets(
  rows: readonly WorkflowRunPruneRow[],
  runDirNames: readonly string[],
  cutoffMs: number,
  nowMs: number,
): PruneTarget[] {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const targets = new Map<string, PruneTarget>();
  const runDirSet = new Set(runDirNames);

  for (const row of rows) {
    if (!isTerminal(row.status)) continue;
    const updatedAtMs = Date.parse(row.updatedAt);
    // A malformed timestamp must never select the row — NaN comparisons are
    // all-false, which would otherwise sail past the cutoff guard.
    if (Number.isNaN(updatedAtMs)) continue;
    if (updatedAtMs >= cutoffMs) continue;
    const ageMs = Math.max(0, nowMs - updatedAtMs);
    targets.set(row.id, {
      ageMs,
      deleteRunDir: runDirSet.has(row.id),
      deleteStoreRow: true,
      runId: row.id,
      status: row.status,
      updatedAt: row.updatedAt,
    });
  }

  for (const runId of runDirNames) {
    if (rowById.has(runId)) continue;
    targets.set(runId, {
      ageMs: 0,
      deleteRunDir: true,
      deleteStoreRow: false,
      runId,
      status: "orphan",
    });
  }

  return [...targets.values()].sort((a, b) => a.runId.localeCompare(b.runId));
}

export function formatPruneAge(ageMs: number): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  if (ageMs >= dayMs) return `${String(Math.floor(ageMs / dayMs))}d`;
  if (ageMs >= hourMs) return `${String(Math.floor(ageMs / hourMs))}h`;
  const minuteMs = 60 * 1000;
  if (ageMs >= minuteMs) return `${String(Math.floor(ageMs / minuteMs))}m`;
  return `${String(Math.max(0, Math.floor(ageMs / 1000)))}s`;
}

export async function executePruneRuns(args: {
  readonly store: Store;
  readonly runsDir: string;
  readonly before: string;
  readonly dryRun?: boolean;
  readonly nowMs?: number;
  readonly pruneFs?: PruneFs;
}): Promise<PruneRunsOutput> {
  const nowMs = args.nowMs ?? Date.now();
  const cutoffMs = computePruneCutoffMs(args.before, nowMs);
  const pruneFs = args.pruneFs ?? createNodePruneFs();
  const rows = args.store.listWorkflowRunsForPrune();
  const runDirNames = await pruneFs.listRunDirNames(args.runsDir);
  const targets = selectPruneTargets(rows, runDirNames, cutoffMs, nowMs);
  const dryRun = args.dryRun === true;

  if (dryRun) {
    return { deletedRunDirs: 0, deletedStoreRows: 0, dryRun: true, failures: [], targets };
  }

  let deletedStoreRows = 0;
  let deletedRunDirs = 0;
  const failures: string[] = [];

  for (const target of targets) {
    // Orphan classification raced against run creation: the dir was listed
    // before a store row existed. Recheck the store at deletion time — a row
    // that appeared since the snapshot means this is a live run, not an orphan.
    if (target.status === "orphan" && hasStoreRowNow(args.store, target.runId)) {
      failures.push(target.runId);
      continue;
    }
    try {
      await pruneOneTarget(args.store, pruneFs, args.runsDir, target);
      if (target.deleteStoreRow) deletedStoreRows += 1;
      if (target.deleteRunDir) deletedRunDirs += 1;
    } catch {
      // Per-target isolation: one failed deletion never strands the rest of
      // the batch. The id is reported; re-running prune retries it.
      failures.push(target.runId);
    }
  }

  return { deletedRunDirs, deletedStoreRows, dryRun: false, failures, targets };
}

function hasStoreRowNow(store: Store, runId: string): boolean {
  try {
    return store.getRun(runId) !== null;
  } catch {
    // A row we cannot read is a row we must not treat as absent.
    return true;
  }
}

async function pruneOneTarget(
  store: Store,
  pruneFs: PruneFs,
  runsDir: string,
  target: PruneTarget,
): Promise<void> {
  // Dir first, row second — both failure orders then self-heal on the next
  // prune: a thrown dir removal leaves the terminal row to retry the pair; a
  // thrown row deletion after the dir is gone leaves a row-only target.
  if (target.deleteRunDir) {
    await pruneFs.removeRunDir(join(runsDir, target.runId));
  }
  if (target.deleteStoreRow) {
    store.deleteWorkflowRun(target.runId);
  }
}

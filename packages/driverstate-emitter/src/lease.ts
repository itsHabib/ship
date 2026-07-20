/**
 * Simple per-run lease file, `{actor, pid, expires_at}`, mirroring workbench
 * `driverstate/lease.go`'s on-disk shape. Deliberately not that package's full
 * generation-fencing/steal machinery: ship's engine is the single writer for
 * its own runs, so a lease here only needs to notice a DIFFERENT live actor,
 * not arbitrate concurrent writers.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { leasePath } from "./paths.js";

export interface LeaseRecord {
  actor: string;
  pid: number;
  expires_at: string;
}

/** A lease older than this is stale and reclaimable by any actor. */
export const DEFAULT_LEASE_TTL_MS = 90_000;

/**
 * Claims (or renews) the lease on run dir `rd` for `actor`. Throws if a
 * DIFFERENT actor holds a live (non-expired) lease — callers of the
 * best-effort `appendEvent` API see this as `{ ok: false }`.
 */
export function claimLease(rd: string, actor: string, ttlMs = DEFAULT_LEASE_TTL_MS): LeaseRecord {
  mkdirSync(rd, { recursive: true });
  const existing = readLease(rd);
  if (existing !== null && existing.actor !== actor && !isExpired(existing)) {
    throw new Error(`driverstate: run held by ${existing.actor}`);
  }
  const rec: LeaseRecord = {
    actor,
    pid: process.pid,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
  writeFileSync(leasePath(rd), JSON.stringify(rec), "utf8");
  return rec;
}

/** Releases `actor`'s lease on `rd`, if it still holds it. A no-op otherwise. */
export function releaseLease(rd: string, actor: string): void {
  const existing = readLease(rd);
  if (existing !== null && existing.actor === actor) {
    rmSync(leasePath(rd), { force: true });
  }
}

function readLease(rd: string): LeaseRecord | null {
  try {
    return JSON.parse(readFileSync(leasePath(rd), "utf8")) as LeaseRecord;
  } catch {
    return null;
  }
}

function isExpired(rec: LeaseRecord): boolean {
  return Date.parse(rec.expires_at) <= Date.now();
}

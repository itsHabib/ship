/**
 * The write contract: append a driver-state event to a run's ledger. Mirrors
 * workbench `driverstate/append.go`'s write window, simplified for a single
 * writer per run (spec: "keep it simple; ship's engine is the single writer
 * for its own runs"):
 *
 *   lock -> truncate torn trailing partial line -> read head for chain +
 *   time-monotonicity -> write + fsync -> release.
 *
 * Every exported write API is best-effort: it catches internally and returns
 * a result value, never throws to the caller.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type { Event } from "./canonical.js";

import { computeHash, encodeEvent, SCHEMA_VERSION } from "./canonical.js";
import { newEventId } from "./id.js";
import { claimLease, releaseLease } from "./lease.js";
import { withLock } from "./lock.js";
import { appendLockPath, ledgerPath, resolveStateRoot, runDir } from "./paths.js";
import { checkTransition } from "./transitions.js";

export interface AppendInput {
  /** Client-minted idempotency key; auto-generated (`evt_<ulid>`) if omitted. */
  id?: string;
  runId: string;
  kind: string;
  stream?: string;
  /** Writer-supplied event time; defaults to now. Truncated to whole UTC seconds. */
  time?: Date;
  actor: string;
  extRef?: string;
  body: unknown;
  /** Overrides `WORKBENCH_STATE_DIR`/`~/.workbench/driver-state`; primarily for tests. */
  stateRoot?: string;
}

export type AppendResult = { ok: true; event: Event } | { ok: false; error: string };

/** Appends an event to its run's ledger. Best-effort: never throws. */
export function appendEvent(input: AppendInput): AppendResult {
  try {
    return { ok: true, event: appendEventOrThrow(input) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Releases `actor`'s lease on a run — call at run end (`run_finished`
 * emitted, or the drive abandoned) so the dir doesn't sit held for the TTL.
 * Best-effort: never throws.
 */
export function releaseRun(runId: string, actor: string, stateRoot?: string): void {
  try {
    releaseLease(runDir(stateRoot ?? resolveStateRoot(), runId), actor);
  } catch {
    // Best-effort — an unreleased lease self-expires within the TTL.
  }
}

function appendEventOrThrow(input: AppendInput): Event {
  const stateRoot = input.stateRoot ?? resolveStateRoot();
  const rd = runDir(stateRoot, input.runId);
  mkdirSync(rd, { recursive: true });
  claimLease(rd, input.actor);
  return withLock(appendLockPath(rd), () => appendLocked(stateRoot, rd, input));
}

function appendLocked(stateRoot: string, rd: string, input: AppendInput): Event {
  const path = ledgerPath(rd);
  const events = readAndHealLedger(path);
  const id = input.id ?? newEventId();

  const committed = findCommitted(stateRoot, events, input, id);
  if (committed !== null) {
    return committed;
  }

  const time = formatTime(input.time ?? new Date());
  const head = events.at(-1);
  assertMonotonic(head, time);
  checkTransition(events, {
    kind: input.kind,
    stream: input.stream ?? "",
    body: input.body,
  });

  const draft: Event = {
    id,
    run: input.runId,
    v: SCHEMA_VERSION,
    kind: input.kind,
    stream: input.stream ?? "",
    time,
    actor: input.actor,
    ext_ref: input.extRef ?? "",
    body: input.body,
    prev: head?.hash ?? "",
    hash: "",
  };
  draft.hash = computeHash(draft);

  appendLine(path, withTrailingNewline(encodeEvent(draft)));
  return draft;
}

/**
 * Returns the already-committed event this append would duplicate, if any:
 * a matching event id (retried append), or — for `run_imported` — a matching
 * `(repo, source, generated_at)` dedupe key on any run. Null means this is a
 * genuinely new event.
 */
function findCommitted(
  stateRoot: string,
  events: Event[],
  input: AppendInput,
  id: string,
): Event | null {
  const existingById = events.find((e) => e.id === id);
  if (existingById !== undefined) {
    return existingById;
  }
  if (input.kind === "run_imported") {
    return findImportDuplicate(stateRoot, input.body);
  }
  return null;
}

function assertMonotonic(head: Event | undefined, time: string): void {
  if (head !== undefined && time < head.time) {
    throw new Error(
      `driverstate: time ${time} is older than head ${head.time} (per-run monotonicity)`,
    );
  }
}

/** Appends a `\n` to `line` — the ledger is newline-delimited JSON. */
function withTrailingNewline(line: Uint8Array): Uint8Array {
  const out = new Uint8Array(line.length + 1);
  out.set(line);
  out[line.length] = 0x0a;
  return out;
}

/** Formats `d` as RFC 3339 truncated to whole UTC seconds, e.g. `2026-07-16T12:00:00Z`. */
export function formatTime(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * Reads a run's ledger, healing a torn final line: bytes after the last
 * newline are a crash's partial write, truncated from the file before
 * parsing. Returns the decoded events in file order.
 */
function readAndHealLedger(path: string): Event[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      return [];
    }
    throw err;
  }
  const lastNewline = raw.lastIndexOf("\n");
  const healed = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  if (healed.length !== raw.length) {
    truncateSync(path, Buffer.byteLength(healed, "utf8"));
  }
  const events: Event[] = [];
  for (const line of healed.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    events.push(JSON.parse(line) as Event);
  }
  return events;
}

function appendLine(path: string, line: Uint8Array): void {
  const fd = openSync(path, "a");
  try {
    // writeSync may legally short-write; loop until the full line is down
    // before the fsync seals it as committed.
    let written = 0;
    while (written < line.length) {
      written += writeSync(fd, line, written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface ImportKey {
  repo: string;
  source: string;
  generatedAt: string;
}

/**
 * Scans every run dir under `stateRoot` (including the target run, so a
 * re-import into the same run also resolves here) for a committed
 * `run_imported` sharing `body`'s `(repo, source, generated_at)` key. Mirrors
 * `driverstate/append.go`'s dedupeImport, without its cross-run import lock —
 * single-writer-per-run means this scan-then-write window has no concurrent
 * importer to race.
 */
function findImportDuplicate(stateRoot: string, body: unknown): Event | null {
  const key = importKey(body);
  if (key === null) {
    return null;
  }
  let entries: string[];
  try {
    entries = readdirSync(stateRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const match = findImportInRun(join(stateRoot, entry), key);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

function findImportInRun(rd: string, key: ImportKey): Event | null {
  if (!isDirectory(rd)) {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(rd), "utf8");
  } catch {
    return null;
  }
  const lastNewline = raw.lastIndexOf("\n");
  const trimmed = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  for (const line of trimmed.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = matchImportLine(line, key);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

function matchImportLine(line: string, key: ImportKey): Event | null {
  let e: Event;
  try {
    e = JSON.parse(line) as Event;
  } catch {
    return null;
  }
  if (e.kind !== "run_imported") {
    return null;
  }
  const k = importKey(e.body);
  if (
    k !== null &&
    k.repo === key.repo &&
    k.source === key.source &&
    k.generatedAt === key.generatedAt
  ) {
    return e;
  }
  return null;
}

function importKey(body: unknown): ImportKey | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const b = body as Record<string, unknown>;
  const repo = b["repo"];
  const source = b["source"];
  const generatedAt = b["generated_at"];
  if (typeof repo !== "string" || repo === "") {
    return null;
  }
  if (typeof source !== "string" || source === "") {
    return null;
  }
  if (typeof generatedAt !== "string" || generatedAt === "") {
    return null;
  }
  return { repo, source, generatedAt };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

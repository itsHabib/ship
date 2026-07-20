/**
 * Write-time state-machine enforcement — the TS mirror of workbench
 * `driverstate/append.go`'s checkTransition (spec §5 table). The emitter
 * validates even though it isn't the driver: an out-of-order emission is
 * rejected here (and surfaced through the best-effort result) instead of
 * writing a ledger the Go reducer would refuse.
 */

import type { Event } from "./canonical.js";

const STATUS_PENDING = "pending";
const STATUS_DISPATCHED = "dispatched";
const STATUS_LANDED = "landed";
const STATUS_PR_OPEN = "pr_open";
const STATUS_MERGED = "merged";
const STATUS_FAILED = "failed";
const STATUS_SKIPPED = "skipped";

const TERMINAL_STATUSES = new Set([STATUS_MERGED, STATUS_SKIPPED, STATUS_FAILED]);

/**
 * Throws when appending `e` after `events` would be an illegal transition:
 * run-scoped kinds by their run-level rules, stream kinds by folding the
 * stream's prior events to a status and applying the spec §5 table.
 */
export function checkTransition(events: Event[], e: DraftEvent): void {
  if (events.some((prior) => prior.kind === "run_finished")) {
    throw illegal("run_finished", e.kind);
  }
  if (e.kind === "run_imported") {
    if (events.length > 0) {
      throw illegal("run_open", e.kind);
    }
    return;
  }
  if (e.kind === "run_finished") {
    checkRunFinished(events);
    return;
  }
  if (events.length === 0) {
    throw illegal("run_absent", e.kind);
  }
  if (e.stream === "") {
    throw new Error(`driverstate: ${e.kind} requires a stream id`);
  }
  applyStream(streamStatus(events, e.stream), e);
  if (e.kind === "stream_attempt") {
    checkSeq(events, e);
  }
}

/** The fields of a not-yet-sealed event that transition checks read. */
export interface DraftEvent {
  kind: string;
  stream: string;
  body: unknown;
}

function checkRunFinished(events: Event[]): void {
  if (events.length === 0) {
    throw illegal("run_absent", "run_finished");
  }
  for (const stream of gatherStreams(events)) {
    const status = streamStatus(events, stream);
    if (!TERMINAL_STATUSES.has(status)) {
      throw illegal(status, "run_finished");
    }
  }
}

/** The run's full stream set: the run_imported manifest snapshot plus any stream that carried an event. */
function gatherStreams(events: Event[]): string[] {
  const streams = new Set<string>();
  for (const e of events) {
    if (e.kind === "run_imported") {
      for (const spec of importedStreams(e.body)) {
        streams.add(spec);
      }
    }
    if (e.stream !== "") {
      streams.add(e.stream);
    }
  }
  return [...streams];
}

function importedStreams(body: unknown): string[] {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const raw = (body as Record<string, unknown>)["streams"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const spec of raw) {
    if (typeof spec !== "object" || spec === null) {
      continue;
    }
    const stream = (spec as Record<string, unknown>)["stream"];
    if (typeof stream === "string" && stream !== "") {
      out.push(stream);
    }
  }
  return out;
}

/**
 * Folds a stream's prior events to its current derived status. Stored events
 * were validated on write, so applyStream never throws here; a stray illegal
 * fold is ignored rather than corrupting the status.
 */
function streamStatus(events: Event[], stream: string): string {
  let status = STATUS_PENDING;
  for (const e of events) {
    if (e.stream !== stream) {
      continue;
    }
    try {
      status = applyStream(status, e);
    } catch {
      // Ignore — mirror of append.go's tolerant fold.
    }
  }
  return status;
}

/**
 * The stream-scoped transition table (spec §5), kind → current status → next.
 * `stream_attempt` is the one body-dependent transition and is handled apart.
 */
const STREAM_TRANSITIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  stream_dispatched: { [STATUS_PENDING]: STATUS_DISPATCHED, [STATUS_FAILED]: STATUS_DISPATCHED },
  stream_failed: { [STATUS_DISPATCHED]: STATUS_FAILED },
  stream_pr_opened: { [STATUS_LANDED]: STATUS_PR_OPEN },
  review_cycle: { [STATUS_PR_OPEN]: STATUS_PR_OPEN },
  stream_merged: { [STATUS_PR_OPEN]: STATUS_MERGED },
  stream_skipped: { [STATUS_PENDING]: STATUS_SKIPPED, [STATUS_FAILED]: STATUS_SKIPPED },
};

/** Applies one stream event to `cur` per the spec §5 table: next status, or throws. */
function applyStream(cur: string, e: DraftEvent): string {
  if (e.kind === "stream_attempt") {
    return applyAttempt(cur, e);
  }
  const next = STREAM_TRANSITIONS[e.kind]?.[cur];
  if (next === undefined) {
    throw illegal(cur, e.kind);
  }
  return next;
}

function applyAttempt(cur: string, e: DraftEvent): string {
  if (cur !== STATUS_DISPATCHED) {
    throw illegal(cur, e.kind);
  }
  const attempt = attemptBody(e.body);
  if (!attempt.terminal) {
    return STATUS_DISPATCHED;
  }
  return attempt.failureCategory === "" ? STATUS_LANDED : STATUS_FAILED;
}

interface AttemptFields {
  seq: number;
  terminal: boolean;
  failureCategory: string;
}

function attemptBody(body: unknown): AttemptFields {
  if (typeof body !== "object" || body === null) {
    throw new Error("driverstate: stream_attempt body is not an object");
  }
  const b = body as Record<string, unknown>;
  const seq = b["seq"];
  const terminal = b["terminal"];
  const failureCategory = b["failure_category"];
  if (typeof seq !== "number" || typeof terminal !== "boolean") {
    throw new Error("driverstate: stream_attempt body: seq/terminal missing");
  }
  return {
    seq,
    terminal,
    failureCategory: typeof failureCategory === "string" ? failureCategory : "",
  };
}

/** Enforces append-only monotone stream_attempt seq per stream. */
function checkSeq(events: Event[], e: DraftEvent & { stream: string }): void {
  const next = attemptBody(e.body).seq;
  for (const prior of events) {
    if (prior.kind !== "stream_attempt" || prior.stream !== e.stream) {
      continue;
    }
    const priorSeq = attemptBody(prior.body).seq;
    if (next <= priorSeq) {
      throw new Error(
        `driverstate: stream_attempt seq ${String(next)} does not exceed prior seq ${String(priorSeq)}`,
      );
    }
  }
}

function illegal(from: string, kind: string): Error {
  return new Error(`driverstate: illegal transition: ${kind} from ${from}`);
}

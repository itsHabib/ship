/**
 * Model-pool assignment policy (model-lottery spec §4).
 *
 * Deterministic round-robin: a pool of `(provider, model_id)` members —
 * optionally runtime-prefixed — is spread over a manifest's assignable
 * streams in manifest order under one global counter. No weights, seeds, or
 * buckets. This module is pure policy: it computes what each stream should
 * become and validates the resulting dispatch cells; the caller owns the
 * manifest file write-back (mechanism).
 */

import type { AgentProvider } from "@ship/workflow";

import type { DriverManifest, ManifestStream } from "./manifest.js";

import { AssignError } from "./errors.js";

type Runtime = NonNullable<ManifestStream["runtime"]>;

const KNOWN_RUNTIMES: readonly Runtime[] = ["local", "cloud", "rooms"];
const KNOWN_PROVIDERS: readonly AgentProvider[] = ["cursor", "claude", "codex"];

// Legal (provider, runtime) cells — the shape of `selectRunner`'s matrix
// (packages/core/src/service.ts). A cell absent here is an authoring error
// (e.g. claude/rooms, codex/cloud); whether a legal cell has a runner wired
// is a dispatch-time concern, not assign-time.
const LEGAL_RUNTIMES_BY_PROVIDER: Record<AgentProvider, readonly Runtime[]> = {
  cursor: ["local", "cloud", "rooms"],
  claude: ["local", "cloud"],
  codex: ["local"],
};

// Manifest stream statuses that assignment never restamps (spec §4.1).
const TERMINAL_STREAM_STATUSES: ReadonlySet<string> = new Set(["done", "skipped"]);

/** One pool member: a dispatch target minus the runtime when unprefixed. */
export interface PoolMember {
  runtime?: Runtime;
  provider: AgentProvider;
  modelId: string;
}

/** What one stream becomes, paired by array position for write-back. */
export interface StreamAssignment {
  batchPos: number;
  streamPos: number;
  specPath: string;
  provider: AgentProvider;
  modelId: string;
  // Runtime to write onto the stream — set only when the pool member carried
  // a runtime prefix (spec §4.3). Absent leaves the stream's runtime as-is.
  stampRuntime?: Runtime;
  // Fully resolved runtime the stream will dispatch on: stamp ?? stream's own
  // ?? manifest default. Used for cell validation and the printed table.
  resolvedRuntime: Runtime;
}

export interface AssignmentPlan {
  assignments: StreamAssignment[];
  skipped: { specPath: string; status: string }[];
}

/**
 * Parse a `--pool` spec: comma-separated `[runtime/]provider:model` members.
 * Throws `AssignError` on any malformed member (the whole spec is rejected).
 */
export function parseModelPool(spec: string): PoolMember[] {
  const raw = spec.split(",").map((entry) => entry.trim());
  const members = raw.filter((entry) => entry.length > 0);
  if (members.length === 0) {
    throw new AssignError("empty model pool: expected at least one provider:model member");
  }
  return members.map(parsePoolMember);
}

function parsePoolMember(member: string): PoolMember {
  const colon = member.indexOf(":");
  if (colon <= 0 || colon === member.length - 1) {
    throw new AssignError(
      `invalid pool member "${member}": expected "[runtime/]provider:model_id"`,
    );
  }
  const modelId = member.slice(colon + 1);
  const head = member.slice(0, colon);
  const { providerPart, runtime } = splitRuntimePrefix(head, member);
  const provider = parseProvider(providerPart, member);
  if (runtime === undefined) {
    return { modelId, provider };
  }
  return { modelId, provider, runtime };
}

function splitRuntimePrefix(
  head: string,
  member: string,
): { providerPart: string; runtime?: Runtime } {
  const slash = head.indexOf("/");
  if (slash === -1) {
    return { providerPart: head };
  }
  const runtimeRaw = head.slice(0, slash);
  const providerPart = head.slice(slash + 1);
  if (!isRuntime(runtimeRaw)) {
    throw new AssignError(
      `invalid pool member "${member}": unknown runtime "${runtimeRaw}" (expected local|cloud|rooms)`,
    );
  }
  return { providerPart, runtime: runtimeRaw };
}

function parseProvider(value: string, member: string): AgentProvider {
  if (!isProvider(value)) {
    throw new AssignError(
      `invalid pool member "${member}": unknown provider "${value}" (expected cursor|claude|codex)`,
    );
  }
  return value;
}

function isRuntime(value: string): value is Runtime {
  return (KNOWN_RUNTIMES as readonly string[]).includes(value);
}

function isProvider(value: string): value is AgentProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Round-robin the pool over the manifest's assignable streams (spec §4.1):
 * manifest order, one global counter, terminal streams skipped without
 * consuming a rotation slot. Validates every resulting `(runtime, provider)`
 * cell up front and rejects the whole batch with the full list of illegal
 * cells — no partial mutation.
 */
export function computeAssignments(manifest: DriverManifest, pool: PoolMember[]): AssignmentPlan {
  if (pool.length === 0) {
    throw new AssignError("cannot assign an empty pool");
  }
  const assignments: StreamAssignment[] = [];
  const skipped: AssignmentPlan["skipped"] = [];
  const defaultRuntime = manifest.default_runtime ?? "local";

  let cursor = 0;
  manifest.batches.forEach((batch, batchPos) => {
    batch.streams.forEach((stream, streamPos) => {
      if (stream.status !== undefined && TERMINAL_STREAM_STATUSES.has(stream.status)) {
        skipped.push({ specPath: stream.spec_path, status: stream.status });
        return;
      }
      const member = pool[cursor % pool.length];
      if (member === undefined) return;
      cursor += 1;
      assignments.push(buildAssignment(batchPos, streamPos, stream, member, defaultRuntime));
    });
  });

  rejectIllegalCells(assignments);
  return { assignments, skipped };
}

function buildAssignment(
  batchPos: number,
  streamPos: number,
  stream: ManifestStream,
  member: PoolMember,
  defaultRuntime: Runtime,
): StreamAssignment {
  // Resolved runtime: a prefixed member wins, else the stream's own runtime,
  // else the manifest default (spec §4.3). Only a prefixed member is stamped.
  const resolvedRuntime = member.runtime ?? stream.runtime ?? defaultRuntime;
  const base: StreamAssignment = {
    batchPos,
    streamPos,
    specPath: stream.spec_path,
    provider: member.provider,
    modelId: member.modelId,
    resolvedRuntime,
  };
  if (member.runtime !== undefined) {
    return { ...base, stampRuntime: member.runtime };
  }
  return base;
}

function rejectIllegalCells(assignments: StreamAssignment[]): void {
  const illegal = assignments
    .filter((assignment) => !isLegalCell(assignment.provider, assignment.resolvedRuntime))
    .map(
      (assignment) =>
        `${assignment.specPath}: ${assignment.resolvedRuntime}/${assignment.provider}`,
    );
  if (illegal.length === 0) {
    return;
  }
  throw new AssignError(
    `unwired dispatch cell(s) — fix the pool or the manifest runtime:\n  ${illegal.join("\n  ")}`,
  );
}

/** True when `(provider, runtime)` is a legal cell of the dispatch matrix. */
export function isLegalCell(provider: AgentProvider, runtime: Runtime): boolean {
  return LEGAL_RUNTIMES_BY_PROVIDER[provider].includes(runtime);
}

/** Normalized `[runtime/]provider:model` string — the recorded pool form. */
export function poolMemberToString(member: PoolMember): string {
  const prefix = member.runtime === undefined ? "" : `${member.runtime}/`;
  return `${prefix}${member.provider}:${member.modelId}`;
}

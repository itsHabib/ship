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
import type { DispatchTarget, ViabilityDeps, ViabilityResult } from "./viability.js";

import { AssignError } from "./errors.js";
import { checkTargetViability } from "./viability.js";

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

  const problems: string[] = [];
  let cursor = 0;
  manifest.batches.forEach((batch, batchPos) => {
    batch.streams.forEach((stream, streamPos) => {
      if (stream.status !== undefined && TERMINAL_STREAM_STATUSES.has(stream.status)) {
        skipped.push({ specPath: stream.spec_path, status: stream.status });
        return;
      }
      // pool is non-empty (guarded above); the `?? ` narrows the
      // noUncheckedIndexedAccess type, it is not a real runtime branch.
      const member = pool[cursor % pool.length] ?? pool[0];
      if (member === undefined) return;
      cursor += 1;
      const assignment = buildAssignment(batchPos, streamPos, stream, member, defaultRuntime);
      assignments.push(assignment);
      const problem = validateAssignment(assignment, stream, manifest.repo_url);
      if (problem !== undefined) problems.push(problem);
    });
  });

  if (problems.length > 0) {
    throw new AssignError(
      `cannot assign — the pool would produce an unrunnable manifest:\n  ${problems.join("\n  ")}`,
    );
  }
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

/**
 * Validate one assignment against everything import + the engine preflight
 * enforce, so a successful assign always yields a runnable manifest (spec
 * §4.3 all-or-nothing). Returns a problem string, or undefined when clean.
 */
function validateAssignment(
  assignment: StreamAssignment,
  stream: ManifestStream,
  repoUrl: string | undefined,
): string | undefined {
  const cell = `${assignment.resolvedRuntime}/${assignment.provider}`;
  if (!isLegalCell(assignment.provider, assignment.resolvedRuntime)) {
    return `${assignment.specPath}: unwired dispatch cell ${cell}`;
  }
  // Branch preconditions mirrored from import (claude/cloud) and the engine
  // preflight (any local stream): both require branch_name.
  const needsBranch =
    assignment.resolvedRuntime === "local" ||
    (assignment.provider === "claude" && assignment.resolvedRuntime === "cloud");
  if (needsBranch && stream.branch_name === undefined) {
    return `${assignment.specPath}: ${cell} requires branch_name — set it or pick a cloud/cursor target`;
  }
  // Cloud streams need a manifest-level repo_url (engine preflight).
  if (assignment.resolvedRuntime === "cloud" && repoUrl === undefined) {
    return `${assignment.specPath}: ${cell} needs repo_url in the manifest frontmatter`;
  }
  return undefined;
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

/** A pool member dropped by preflight, with the reason it was dropped. */
export interface DroppedMember {
  member: PoolMember;
  reason: string;
}

/** Preflight outcome: surviving members and dropped ones, in original order. */
export interface PreflightResult {
  effective: PoolMember[];
  dropped: DroppedMember[];
}

/**
 * Filter `pool` to its viable members (spec §5). A prefixed member resolves to
 * one target; an unprefixed member could be assigned to any assignable stream,
 * so it is checked against every distinct runtime among them (`candidateRuntimes`)
 * and kept only if viable on all of them. This is conservative on purpose: a
 * viability check that passed on the manifest default but failed on a stream's
 * own runtime would let a credential-less dispatch through — the exact failure
 * preflight exists to catch. Each unique target is checked once; partition
 * preserves pool order. A rejecting `deps.listCursorModels` propagates.
 */
export async function preflightPool(
  pool: PoolMember[],
  candidateRuntimes: Runtime[],
  deps: ViabilityDeps,
): Promise<PreflightResult> {
  const memberTargets = pool.map((member) => ({
    member,
    targets: candidateTargets(member, candidateRuntimes),
  }));

  const targetByKey = new Map<string, DispatchTarget>();
  for (const { targets } of memberTargets) {
    for (const target of targets) targetByKey.set(targetKey(target), target);
  }

  const verdicts = new Map<string, ViabilityResult>();
  await Promise.all(
    [...targetByKey].map(async ([key, target]) => {
      verdicts.set(key, await checkTargetViability(target, deps));
    }),
  );

  const effective: PoolMember[] = [];
  const dropped: DroppedMember[] = [];
  for (const { member, targets } of memberTargets) {
    const failure = firstFailingReason(targets, verdicts);
    if (failure === undefined) {
      effective.push(member);
      continue;
    }
    dropped.push({ member, reason: failure });
  }
  return { dropped, effective };
}

/**
 * The targets a member could dispatch on: its prefix runtime if it carries one,
 * else every runtime an assignable stream could resolve to (an unprefixed member
 * inherits the stream's runtime at assignment, unknown during this whole-pool phase).
 */
function candidateTargets(member: PoolMember, candidateRuntimes: Runtime[]): DispatchTarget[] {
  const runtimes = member.runtime !== undefined ? [member.runtime] : candidateRuntimes;
  return runtimes.map((runtime) => ({
    modelId: member.modelId,
    provider: member.provider,
    runtime,
  }));
}

function firstFailingReason(
  targets: DispatchTarget[],
  verdicts: Map<string, ViabilityResult>,
): string | undefined {
  for (const target of targets) {
    const verdict = verdicts.get(targetKey(target)) ?? unresolvedVerdict();
    if (!verdict.viable) return verdict.reason;
  }
  return undefined;
}

function targetKey(target: DispatchTarget): string {
  return `${target.runtime}/${target.provider}:${target.modelId}`;
}

function unresolvedVerdict(): ViabilityResult {
  return { reason: "preflight produced no verdict", viable: false };
}

/** Distinct resolved runtimes across the manifest's assignable (non-terminal) streams. */
export function assignableRuntimes(manifest: DriverManifest): Runtime[] {
  const defaultRuntime = manifest.default_runtime ?? "local";
  const runtimes = manifest.batches
    .flatMap((batch) => batch.streams)
    .filter((stream) => !isTerminalStream(stream))
    .map((stream) => stream.runtime ?? defaultRuntime);
  return [...new Set(runtimes)];
}

function isTerminalStream(stream: ManifestStream): boolean {
  return stream.status !== undefined && TERMINAL_STREAM_STATUSES.has(stream.status);
}

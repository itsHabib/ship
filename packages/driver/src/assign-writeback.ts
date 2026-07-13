/**
 * Manifest write-back for `driver assign` (mechanism, not policy).
 *
 * Mutates the manifest's frontmatter in place via the YAML Document API so a
 * stream's stamps land without reordering or dropping the rest of the file
 * (comments on rewritten lines are the one accepted loss, spec §9 Q1). The
 * assignment decisions and the preflight filter come from `assign.ts`; this
 * module orchestrates parse → preflight → compute → write and records the
 * outcome in the manifest's `assignment` advisory block.
 */

import { parseDocument } from "yaml";

import type { AssignmentPlan, DroppedMember, PoolMember, StreamAssignment } from "./assign.js";
import type { DriverManifest } from "./manifest.js";
import type { ViabilityDeps } from "./viability.js";

import { computeAssignments, parseModelPool, poolMemberToString, preflightPool } from "./assign.js";
import { AssignError } from "./errors.js";
import { parseManifest } from "./manifest.js";

/** Result of assigning a pool over a manifest: the rewritten text + a summary. */
export interface AssignResult {
  text: string;
  assignments: StreamAssignment[];
  skipped: { specPath: string; status: string }[];
  pool: PoolMember[];
  effectivePool: PoolMember[];
  dropped: DroppedMember[];
}

/** Preflight + clock injection for `assignModelPoolToManifest`. */
export interface AssignOptions {
  // Preflight is opt-in for this entry point (no network by default); the CLI
  // turns it on unless --no-preflight. `deps` is required when `preflight` is true.
  preflight?: boolean;
  deps?: ViabilityDeps;
  // Clock for the advisory `assigned_at`. Injected so tests pin it and the
  // stream stamps stay byte-deterministic (spec §4.1); defaults to wall clock.
  now?: () => string;
}

interface SplitManifest {
  bom: string;
  frontmatter: string;
  body: string;
}

interface AssignmentAdvisory {
  pool: PoolMember[];
  effectivePool: PoolMember[];
  dropped: DroppedMember[];
  assignedAt: string;
}

/**
 * Parse `manifestText`, optionally preflight `poolSpec` down to its viable
 * members, round-robin the effective pool over the assignable streams, and
 * return the rewritten manifest plus a summary. Pure text-in/text-out — the
 * caller owns reading and writing the file. Throws `AssignError` on a malformed
 * manifest or pool, an unwired dispatch cell, or an empty effective pool (every
 * member dropped) — the last aborts before any write-back.
 */
export async function assignModelPoolToManifest(
  manifestText: string,
  poolSpec: string,
  options: AssignOptions = {},
): Promise<AssignResult> {
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) {
    throw new AssignError(
      `manifest parse failed: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const pool = parseModelPool(poolSpec);
  const { dropped, effective } = await resolveEffectivePool(parsed.manifest, pool, options);
  if (effective.length === 0) {
    throw new AssignError(
      `cannot assign — preflight dropped every pool member:\n  ${formatDropped(dropped)}`,
    );
  }
  const plan = computeAssignments(parsed.manifest, effective);
  const now = options.now ?? defaultNow;
  const advisory: AssignmentAdvisory = {
    assignedAt: now(),
    dropped,
    effectivePool: effective,
    pool,
  };
  const text = applyAssignmentToManifest(manifestText, plan, advisory);
  return {
    assignments: plan.assignments,
    dropped,
    effectivePool: effective,
    pool,
    skipped: plan.skipped,
    text,
  };
}

async function resolveEffectivePool(
  manifest: DriverManifest,
  pool: PoolMember[],
  options: AssignOptions,
): Promise<{ effective: PoolMember[]; dropped: DroppedMember[] }> {
  if (options.preflight !== true) {
    return { dropped: [], effective: pool };
  }
  if (options.deps === undefined) {
    throw new AssignError("preflight requested but no viability deps were provided");
  }
  const defaultRuntime = manifest.default_runtime ?? "local";
  return preflightPool(pool, defaultRuntime, options.deps);
}

/**
 * Apply an assignment plan to raw manifest text, returning the rewritten
 * document. Stamps `provider` / `model_id` (and `runtime` when the member was
 * prefixed) per assigned stream and records the pool, effective pool, dropped
 * members, and stamp time under a top-level `assignment` advisory key.
 */
export function applyAssignmentToManifest(
  manifestText: string,
  plan: AssignmentPlan,
  advisory: AssignmentAdvisory,
): string {
  const { body, bom, frontmatter } = splitManifest(manifestText);
  const doc = parseDocument(frontmatter, { prettyErrors: false });
  if (doc.errors.length > 0) {
    throw new AssignError(
      `manifest frontmatter is not valid YAML: ${doc.errors[0]?.message ?? ""}`,
    );
  }

  for (const assignment of plan.assignments) {
    const path = ["batches", assignment.batchPos, "streams", assignment.streamPos];
    doc.setIn([...path, "provider"], assignment.provider);
    doc.setIn([...path, "model_id"], assignment.modelId);
    if (assignment.stampRuntime !== undefined) {
      doc.setIn([...path, "runtime"], assignment.stampRuntime);
    }
  }

  doc.set("assignment", renderAdvisory(advisory));

  // Preserve the source line-ending style: yaml renders LF, so convert the
  // rewritten frontmatter + fences to CRLF when the input used it. The body
  // keeps whatever endings splitManifest captured.
  const eol = manifestText.includes("\r\n") ? "\r\n" : "\n";
  const rendered = doc.toString({ lineWidth: 0 }).trimEnd().replace(/\n/g, eol);
  return `${bom}---${eol}${rendered}${eol}---${body}`;
}

function renderAdvisory(advisory: AssignmentAdvisory): {
  pool: string[];
  effective_pool: string[];
  dropped: { member: string; reason: string }[];
  assigned_at: string;
} {
  return {
    assigned_at: advisory.assignedAt,
    dropped: advisory.dropped.map((entry) => ({
      member: poolMemberToString(entry.member),
      reason: entry.reason,
    })),
    effective_pool: advisory.effectivePool.map(poolMemberToString),
    pool: advisory.pool.map(poolMemberToString),
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}

function formatDropped(dropped: DroppedMember[]): string {
  return dropped
    .map((entry) => `${poolMemberToString(entry.member)}: ${entry.reason}`)
    .join("\n  ");
}

function splitManifest(text: string): SplitManifest {
  const bom = text.charCodeAt(0) === 0xfeff ? String.fromCharCode(0xfeff) : "";
  const stripped = bom === "" ? text : text.slice(1);
  const match = /^---\r?\n([\s\S]*?)\r?\n---((?:\r?\n[\s\S]*)?)$/.exec(stripped);
  if (match === null) {
    throw new AssignError("manifest is missing its driver frontmatter fences");
  }
  const frontmatter = match[1];
  const body = match[2];
  if (frontmatter === undefined || body === undefined) {
    throw new AssignError("manifest frontmatter split failed");
  }
  return { body, bom, frontmatter };
}

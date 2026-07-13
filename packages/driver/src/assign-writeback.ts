/**
 * Manifest write-back for `driver assign` (mechanism, not policy).
 *
 * Mutates the manifest's frontmatter in place via the YAML Document API so a
 * stream's stamps land without reordering or dropping the rest of the file
 * (comments on rewritten lines are the one accepted loss, spec §9 Q1). The
 * assignment decisions come from `assign.ts`; this module only applies them.
 */

import { parseDocument } from "yaml";

import type { AssignmentPlan, PoolMember, StreamAssignment } from "./assign.js";

import { computeAssignments, parseModelPool, poolMemberToString } from "./assign.js";
import { AssignError } from "./errors.js";
import { parseManifest } from "./manifest.js";

/** Result of assigning a pool over a manifest: the rewritten text + a summary. */
export interface AssignResult {
  text: string;
  assignments: StreamAssignment[];
  skipped: { specPath: string; status: string }[];
  pool: PoolMember[];
}

interface SplitManifest {
  bom: string;
  frontmatter: string;
  body: string;
}

/**
 * Parse `manifestText`, round-robin `poolSpec` over its assignable streams,
 * and return the rewritten manifest plus a summary. Pure text-in/text-out —
 * the caller owns reading and writing the file. Throws `AssignError` on a
 * malformed manifest or pool, or an unwired dispatch cell (all-or-nothing).
 */
export function assignModelPoolToManifest(manifestText: string, poolSpec: string): AssignResult {
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) {
    throw new AssignError(
      `manifest parse failed: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const pool = parseModelPool(poolSpec);
  const plan = computeAssignments(parsed.manifest, pool);
  const text = applyAssignmentToManifest(manifestText, plan, pool);
  return { assignments: plan.assignments, pool, skipped: plan.skipped, text };
}

/**
 * Apply an assignment plan to raw manifest text, returning the rewritten
 * document. Stamps `provider` / `model_id` (and `runtime` when the member was
 * prefixed) per assigned stream and records the pool under a top-level
 * `assignment` advisory key for reproducibility.
 */
export function applyAssignmentToManifest(
  manifestText: string,
  plan: AssignmentPlan,
  pool: PoolMember[],
): string {
  const { bom, frontmatter, body } = splitManifest(manifestText);
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

  doc.set("assignment", { pool: pool.map(poolMemberToString) });

  const rendered = doc.toString({ lineWidth: 0 }).trimEnd();
  return `${bom}---\n${rendered}\n---${body}`;
}

function splitManifest(text: string): SplitManifest {
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
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

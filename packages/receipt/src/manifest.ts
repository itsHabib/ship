/**
 * Adapter: a work-driver `driver.md` manifest → driver receipts.
 *
 * The manifest is the richest single source in the loop — its per-stream
 * frontmatter already carries the outcome (status, pr_number, merge_commit,
 * merged_at, cycles, runtime) plus task linkage. This module parses the YAML
 * frontmatter leniently (manifests are hand/tool-authored and may omit fields)
 * and flattens `batches[].streams[]` into one receipt per stream, carrying the
 * manifest-level project/phase/repo context down to each row.
 *
 * Pure: a manifest string in, receipts out. No filesystem, no clock.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { Receipt, ReceiptOutcome } from "./schema.js";

import { buildReceipt } from "./schema.js";

const streamSchema = z
  .object({
    task_id: z.string().optional(),
    task_slug: z.string().optional(),
    spec_path: z.string().optional(),
    branch_name: z.string().optional(),
    status: z.string().optional(),
    pr_number: z.number().int().optional(),
    merge_commit: z.string().optional(),
    merged_at: z.string().optional(),
    cycles: z.number().int().optional(),
    runtime: z.enum(["local", "cloud"]).optional(),
  })
  .passthrough();

const batchSchema = z
  .object({
    id: z.number().int().optional(),
    streams: z.array(streamSchema).default([]),
  })
  .passthrough();

const manifestSchema = z
  .object({
    generated_at: z.string().optional(),
    repo: z.string().optional(),
    source: z
      .object({ project: z.string().optional(), phase: z.string().optional() })
      .partial()
      .optional(),
    batches: z.array(batchSchema).default([]),
  })
  .passthrough();

type Stream = z.infer<typeof streamSchema>;

interface ManifestContext {
  batch_id: number | undefined;
  project: string | undefined;
  phase: string | undefined;
  repo: string | undefined;
  generated_at: string | undefined;
}

export const CYCLE_CAP = 3;

/** Parse a `driver.md` manifest into one driver receipt per stream. */
export function manifestToReceipts(text: string): Receipt[] {
  const frontmatter = extractFrontmatter(text);
  if (frontmatter === null) {
    return [];
  }

  const parsed = manifestSchema.safeParse(parseYaml(frontmatter));
  if (!parsed.success) {
    return [];
  }

  const manifest = parsed.data;
  const project = manifest.source?.project;
  const phase = manifest.source?.phase;

  return manifest.batches.flatMap((batch) =>
    batch.streams.map((stream) =>
      streamToReceipt(stream, {
        batch_id: batch.id,
        project,
        phase,
        repo: manifest.repo,
        generated_at: manifest.generated_at,
      }),
    ),
  );
}

function streamToReceipt(stream: Stream, ctx: ManifestContext): Receipt {
  const cycles = stream.cycles;
  return buildReceipt({
    key: streamKey(stream, ctx),
    source: "driver",
    outcome: streamOutcome(stream.status, stream.merge_commit),
    project: ctx.project,
    phase: ctx.phase,
    repo: ctx.repo,
    runtime: stream.runtime,
    task_id: stream.task_id,
    task_slug: stream.task_slug,
    doc_path: stream.spec_path,
    branch: stream.branch_name,
    pr_number: stream.pr_number,
    merge_commit: stream.merge_commit,
    cycles,
    cycles_capped: cycles === undefined ? undefined : cycles >= CYCLE_CAP,
    merged_at: stream.merged_at,
    generated_at: ctx.generated_at,
    batch_id: ctx.batch_id,
  });
}

function streamOutcome(
  status: string | undefined,
  mergeCommit: string | undefined,
): ReceiptOutcome {
  if (mergeCommit !== undefined && mergeCommit !== "") {
    return "merged";
  }
  if (status === "done") {
    return "succeeded";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "pending" || status === "todo") {
    return "pending";
  }
  return "unknown";
}

/** A stream's stable, source-scoped key: task id, else branch, else PR, else synthesized. */
function streamKey(stream: Stream, ctx: ManifestContext): string {
  if (stream.task_id !== undefined && stream.task_id !== "") {
    return stream.task_id;
  }
  if (stream.branch_name !== undefined && stream.branch_name !== "") {
    return stream.branch_name;
  }
  if (stream.pr_number !== undefined) {
    return `pr-${String(stream.pr_number)}`;
  }
  return `${ctx.project ?? "unknown"}:${String(ctx.batch_id ?? 0)}:${stream.task_slug ?? "stream"}`;
}

/** Extract the leading `---`-fenced YAML frontmatter block, or null if absent. */
function extractFrontmatter(text: string): string | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (match === null) {
    return null;
  }
  return match[1] ?? null;
}

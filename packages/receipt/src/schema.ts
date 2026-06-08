/**
 * The run-receipt contract: one row per unit of agent work.
 *
 * A receipt is the joined, queryable record of a single trip through the
 * workbench loop — sourced today from two structured artifacts:
 *
 *   - `driver`   — a work-driver manifest stream (the loop OUTCOME: PR, merge,
 *                  review cycles, runtime, task linkage).
 *   - `ship-run` — a persisted ship run dir (the EXECUTION detail: terminal
 *                  status, duration, model).
 *
 * Most fields are optional because the two sources populate different columns;
 * the report layer segments by `source` so a metric never silently mixes a
 * column one source never fills. The deterministic dedupe identity is
 * `${source}:${key}` — see `receiptIdentity`.
 *
 * `schema_version` is the forward-compat hinge: bump it on any breaking shape
 * change so a reader can branch instead of mis-parsing an old corpus.
 */

import { z } from "zod";

export const RECEIPT_SCHEMA_VERSION = 1;

export const receiptSourceSchema = z.enum(["driver", "ship-run"]);
export type ReceiptSource = z.infer<typeof receiptSourceSchema>;

/**
 * Unified outcome across both sources. Driver streams collapse
 * `done` + a merge commit → `merged`; ship runs map their terminal status.
 */
export const receiptOutcomeSchema = z.enum([
  "merged",
  "succeeded",
  "failed",
  "cancelled",
  "pending",
  "unknown",
]);
export type ReceiptOutcome = z.infer<typeof receiptOutcomeSchema>;

export const receiptRuntimeSchema = z.enum(["local", "cloud"]);
export type ReceiptRuntime = z.infer<typeof receiptRuntimeSchema>;

export const receiptSchema = z.object({
  schema_version: z.literal(RECEIPT_SCHEMA_VERSION),
  key: z.string().min(1),
  source: receiptSourceSchema,
  outcome: receiptOutcomeSchema,

  project: z.string().optional(),
  phase: z.string().optional(),
  repo: z.string().optional(),
  runtime: receiptRuntimeSchema.optional(),

  task_id: z.string().optional(),
  task_slug: z.string().optional(),
  doc_path: z.string().optional(),
  branch: z.string().optional(),

  pr_number: z.number().int().positive().optional(),
  pr_url: z.string().optional(),
  merge_commit: z.string().optional(),
  cycles: z.number().int().nonnegative().optional(),
  cycles_capped: z.boolean().optional(),

  run_id: z.string().optional(),
  ship_status: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  // `null` = run completed but token usage was not captured (a known unknown,
  // distinct from "not applicable / absent"). Populated by a later phase.
  cost_tokens: z.number().int().nonnegative().nullable().optional(),

  dispatched_at: z.string().optional(),
  terminal_at: z.string().optional(),
  merged_at: z.string().optional(),
  generated_at: z.string().optional(),
  batch_id: z.number().int().optional(),

  // `null` = explicitly observed "no human stepped in"; absent = not assessed.
  human_intervention: z.string().nullable().optional(),
  friction_tags: z.array(z.string()).optional(),
});

export type Receipt = z.infer<typeof receiptSchema>;

/** Validate + normalize a loose record into a `Receipt` (throws on invalid). */
export function buildReceipt(raw: Record<string, unknown>): Receipt {
  return receiptSchema.parse({ ...raw, schema_version: RECEIPT_SCHEMA_VERSION });
}

/** Source-scoped dedupe identity used by `upsertReceipts`. */
export function receiptIdentity(receipt: Pick<Receipt, "key" | "source">): string {
  return `${receipt.source}:${receipt.key}`;
}

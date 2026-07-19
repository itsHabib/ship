/**
 * Zod schemas and domain types for `driver_*` store tables.
 */

import { agentProviderSchema } from "@ship/workflow";
import { z } from "zod";

export const driverRunStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_judgment",
  "done",
  "failed",
  "cancelled",
]);

export const driverBatchStatusSchema = z.enum(["pending", "running", "done", "failed"]);

export const driverStreamStatusSchema = z.enum([
  "pending",
  "dispatching",
  "dispatched",
  "landed",
  "failed",
  "skipped",
  "done",
]);

export const driverRuntimeSchema = z.enum(["local", "cloud", "rooms"]);

export const driverModelTierSchema = z.enum(["opus", "sonnet", "fable"]);
export const driverEffortTierSchema = z.enum(["extra", "max", "ultracode"]);

export const shipInputModelParamEntrySchema = z
  .object({
    id: z.string().min(1),
    value: z.union([z.string().min(1), z.boolean()]),
  })
  .strict();

export const streamAttemptSchema = z
  .object({
    dispatchedAt: z.string().datetime({ offset: true }),
    docPath: z.string().optional(),
    failureCategory: z.string().optional(),
    // Marks a human `decide retry` that cleared a tripped dispatch breaker: the
    // consecutive-failure count restarts strictly after this attempt. Stored on
    // the existing `attempts` JSON blob — no column, no migration.
    resetBoundary: z.boolean().optional(),
    terminal: z.boolean(),
    workflowRunId: z.string().optional(),
  })
  .strict();

// A persisted fallback dispatch target (dispatch-fallback spec §4.1/§5): the
// shared `(runtime, provider, model_id?)` vocabulary — structurally the driver's
// `DispatchTarget` (viability.ts) with `modelId` optional (omitted → tier
// mapping stands at dispatch). Defined here, not imported, because `@ship/store`
// cannot depend on `@ship/driver` (driver → store, not the reverse).
export const fallbackChainTargetSchema = z
  .object({
    runtime: driverRuntimeSchema,
    provider: agentProviderSchema,
    modelId: z.string().min(1).optional(),
  })
  .strict();

// One append-only `fallbackLog` record (spec §5). No record is written before
// P2a (engine hop); the shapes ship now so the column round-trips and the walk
// has a schema to append to. A `union`, not a discriminated union — the three
// variants key on distinct fields (`from` / `skipped` / `retried`).
export const fallbackLogRecordSchema = z.union([
  z
    .object({
      from: fallbackChainTargetSchema,
      to: fallbackChainTargetSchema,
      fromModel: z.string().optional(),
      toModel: z.string().optional(),
      category: z.string(),
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      skipped: fallbackChainTargetSchema,
      reason: z.string(),
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      retried: fallbackChainTargetSchema,
      reason: z.string(),
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export const driverStreamSchema = z
  .object({
    attempts: z.array(streamAttemptSchema),
    branch: z.string().optional(),
    /** When true, cloud dispatch continues on `branch` instead of the default ref. */
    workOnCurrentBranch: z.boolean().optional(),
    createdAt: z.string().datetime({ offset: true }),
    cycles: z.number().int().optional(),
    // Engine-owned re-dispatch counter, bumped once per `driver address`.
    // Distinct from `cycles` (seat-reported coordinator passes at merge time).
    reviewCycles: z.number().int().optional(),
    driverBatchId: z.string(),
    driverRunId: z.string(),
    errorMessage: z.string().optional(),
    id: z.string(),
    mergeCommit: z.string().optional(),
    mergedAt: z.string().datetime({ offset: true }).optional(),
    prNumber: z.number().int().optional(),
    prUrl: z.string().optional(),
    runtime: driverRuntimeSchema,
    specPath: z.string(),
    status: driverStreamStatusSchema,
    streamIndex: z.number().int().min(0),
    taskId: z.string().optional(),
    taskSlug: z.string().optional(),
    // Task ids a collapsed stream stands in for; the engine closes all of them
    // at land time. Absent (not empty) when the stream rolls up nothing.
    rollsUp: z.array(z.string()).optional(),
    touches: z.array(z.string()),
    modelTier: driverModelTierSchema.optional(),
    // Requested verbatim provider catalog id; wins over modelTier for model
    // selection. dispatchModel records what actually went out.
    modelId: z.string().min(1).optional(),
    effortTier: driverEffortTierSchema.optional(),
    provider: agentProviderSchema.optional(),
    dispatchProvider: agentProviderSchema.optional(),
    dispatchModel: z.string().optional(),
    dispatchModelParams: z.array(shipInputModelParamEntrySchema).optional(),
    effortDegraded: z.boolean().optional(),
    tierDegradeReason: z.string().optional(),
    // Fallback dispatch chain, frozen at import (dispatch-fallback spec §5).
    // Absent for streams with no chain — the feature is opt-in. cursor/log are
    // meaningless without a chain, so all three travel together.
    fallbackChain: z.array(fallbackChainTargetSchema).optional(),
    fallbackCursor: z.number().int().min(0).optional(),
    fallbackLog: z.array(fallbackLogRecordSchema).optional(),
    updatedAt: z.string().datetime({ offset: true }),
    workflowRunId: z.string().optional(),
  })
  .strict()
  .superRefine((stream, ctx) => {
    const set = [stream.fallbackChain, stream.fallbackCursor, stream.fallbackLog].filter(
      (v) => v !== undefined,
    ).length;
    if (set === 0 || set === 3) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fallbackChain, fallbackCursor, and fallbackLog must be set together",
    });
  });

export const driverBatchSchema = z
  .object({
    batchIndex: z.number().int(),
    completedAt: z.string().datetime({ offset: true }).optional(),
    dependsOn: z.array(z.number().int()),
    driverRunId: z.string(),
    id: z.string(),
    label: z.string().optional(),
    status: driverBatchStatusSchema,
    streams: z.array(driverStreamSchema),
  })
  .strict();

export const driverRunSchema = z
  .object({
    batches: z.array(driverBatchSchema),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string(),
    manifestPath: z.string(),
    phase: z.string().optional(),
    project: z.string().optional(),
    repo: z.string(),
    sourceJson: z.string(),
    status: driverRunStatusSchema,
    tickEndedAt: z.string().datetime({ offset: true }).optional(),
    tickStartedAt: z.string().datetime({ offset: true }).optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type DriverRunStatus = z.infer<typeof driverRunStatusSchema>;
export type DriverBatchStatus = z.infer<typeof driverBatchStatusSchema>;
export type DriverStreamStatus = z.infer<typeof driverStreamStatusSchema>;
export type StreamAttempt = z.infer<typeof streamAttemptSchema>;
export type FallbackChainTarget = z.infer<typeof fallbackChainTargetSchema>;
export type FallbackLogRecord = z.infer<typeof fallbackLogRecordSchema>;
export type DriverStream = z.infer<typeof driverStreamSchema>;
export type DriverBatch = z.infer<typeof driverBatchSchema>;
export type DriverRun = z.infer<typeof driverRunSchema>;

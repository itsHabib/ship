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
    effortTier: driverEffortTierSchema.optional(),
    provider: agentProviderSchema.optional(),
    dispatchProvider: agentProviderSchema.optional(),
    dispatchModel: z.string().optional(),
    dispatchModelParams: z.array(shipInputModelParamEntrySchema).optional(),
    effortDegraded: z.boolean().optional(),
    tierDegradeReason: z.string().optional(),
    updatedAt: z.string().datetime({ offset: true }),
    workflowRunId: z.string().optional(),
  })
  .strict();

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
export type DriverStream = z.infer<typeof driverStreamSchema>;
export type DriverBatch = z.infer<typeof driverBatchSchema>;
export type DriverRun = z.infer<typeof driverRunSchema>;

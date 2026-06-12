/**
 * Zod schemas and domain types for `driver_*` store tables.
 */

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

export const streamAttemptSchema = z
  .object({
    dispatchedAt: z.string().datetime({ offset: true }),
    failureCategory: z.string().optional(),
    terminal: z.boolean(),
    workflowRunId: z.string(),
  })
  .strict();

export const driverStreamSchema = z
  .object({
    attempts: z.array(streamAttemptSchema),
    branch: z.string().optional(),
    createdAt: z.string().datetime({ offset: true }),
    cycles: z.number().int().optional(),
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
    touches: z.array(z.string()),
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

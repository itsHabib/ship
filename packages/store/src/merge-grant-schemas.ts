/**
 * Zod schemas and domain types for merge-grant store tables.
 */

import { z } from "zod";

export const mergeGrantSchema = z
  .object({
    grantedAt: z.string().datetime({ offset: true }),
    id: z.string(),
    repo: z.string(),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const mergeGrantSatisfactionSchema = z
  .object({
    driverRunId: z.string(),
    driverStreamId: z.string(),
    grantId: z.string(),
    id: z.string(),
    mergeCommit: z.string(),
    prNumber: z.number().int(),
    satisfiedAt: z.string().datetime({ offset: true }),
    verdictJson: z.string(),
  })
  .strict();

export type MergeGrant = z.infer<typeof mergeGrantSchema>;
export type MergeGrantSatisfaction = z.infer<typeof mergeGrantSatisfactionSchema>;

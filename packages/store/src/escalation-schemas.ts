/**
 * Zod hydration for `escalations` rows.
 */

import { z } from "zod";

export const escalationSchema = z.object({
  id: z.string(),
  driverRunId: z.string().optional(),
  streamId: z.string().optional(),
  repo: z.string().optional(),
  class: z.string(),
  payloadJson: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  notifiedAt: z.string().datetime({ offset: true }).optional(),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
  resolution: z.string().optional(),
});

export type Escalation = z.infer<typeof escalationSchema>;

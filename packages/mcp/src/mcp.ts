/**
 * MCP tool I/O schemas — the wire contract between Ship's MCP server and its
 * clients. V1 tools: `ship`, `get_workflow_run`, `list_workflow_runs`,
 * `cancel_workflow_run`. All schemas are `.strict()`.
 */

import {
  terminalCursorRunRefSchema,
  terminalWorkflowStatusSchema,
  workflowRunSchema,
  workflowStatusSchema,
  worktreeRefSchema,
} from "@ship/workflow";
import { z } from "zod";

// Canonical-ULID pattern: 26 chars of Crockford base32, with the first char
// constrained to 0-7 (it encodes only 3 bits of the 48-bit timestamp).
const WORKFLOW_RUN_ID_PATTERN = /^wf_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const workflowRunIdSchema = z.string().regex(WORKFLOW_RUN_ID_PATTERN);

// =====================================================================
// ship
// =====================================================================

/**
 * Allowed values for the `thinking` Cursor model parameter. Narrow enum
 * (not the broader `ModelSelection.params` array) — exposing one knob at
 * a time keeps Ship's surface insulated from churn in Cursor's parameter
 * grid. Per `cursor.com/docs/sdk/typescript`, omitting the param means
 * "use whatever `isDefault` is set on the server today"; pinning the
 * value at this layer prevents silent shifts across Cursor releases.
 */
export const thinkingEffortSchema = z.enum(["low", "high"]);
export type ThinkingEffort = z.infer<typeof thinkingEffortSchema>;

/** Input to the `ship` tool. Optional fields default in `core`. */
export const shipInputSchema = z
  .object({
    /** Absolute path of the workspace the caller created. `core` runs the agent here. */
    workdir: z.string().min(1),
    /** Path to the task doc. Relative paths resolve against `workdir`; absolute paths are also accepted as long as they realpath inside `workdir`. Symlink-escape rejected by `core`. */
    docPath: z.string().min(1),
    repo: z.string().min(1),
    worktreeName: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    /**
     * Override for the Cursor `thinking` model parameter. Omitted →
     * fall back to the wiring-level default (`"high"` in production).
     * E2E suites pass `"low"` to downshift cost / latency.
     */
    thinking: thinkingEffortSchema.optional(),
  })
  .strict();
export type ShipInput = z.infer<typeof shipInputSchema>;

/**
 * Absolute paths to the named artifacts a `ship` run produces (directory is
 * `CursorRunRef.artifactsDir`). `summary.md` is surfaced inline as
 * `ShipOutput.summary` instead of by path.
 */
export const shipArtifactsSchema = z
  .object({
    promptPath: z.string().min(1),
    eventsPath: z.string().min(1),
    resultPath: z.string().min(1),
  })
  .strict();
export type ShipArtifacts = z.infer<typeof shipArtifactsSchema>;

/**
 * Output of the `ship` tool — the result of a completed run. Both `status`
 * and `cursorRun.status` are restricted to terminal values; V1 blocks until
 * the run finishes.
 */
export const shipOutputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
    status: terminalWorkflowStatusSchema,
    worktree: worktreeRefSchema,
    cursorRun: terminalCursorRunRefSchema,
    artifacts: shipArtifactsSchema,
    // Final assistant text (contents of `summary.md`); absent when the run
    // errored before producing a final message.
    summary: z.string().min(1).optional(),
  })
  .strict();
export type ShipOutput = z.infer<typeof shipOutputSchema>;

// V2 async start-shape — the `ship` MCP tool returns this immediately
// after the row + initial phase row are persisted and transitioned to
// `running`. Callers poll `get_workflow_run` for terminal state. The
// `status` field is narrowed to `z.literal("running")` (not the broader
// `workflowStatusSchema`) so a future implementation that accidentally
// returns a different status fails Zod validation at the MCP boundary,
// not silently in production.
export const shipStartOutputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
    status: z.literal("running"),
  })
  .strict();
export type ShipStartOutput = z.infer<typeof shipStartOutputSchema>;

// =====================================================================
// get_workflow_run
// =====================================================================

/** Input to `get_workflow_run` — point lookup by id. */
export const getWorkflowRunInputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
  })
  .strict();
export type GetWorkflowRunInput = z.infer<typeof getWorkflowRunInputSchema>;

/** Output of `get_workflow_run` — the full hydrated `WorkflowRun`. */
export const getWorkflowRunOutputSchema = workflowRunSchema;
export type GetWorkflowRunOutput = z.infer<typeof getWorkflowRunOutputSchema>;

// =====================================================================
// list_workflow_runs
// =====================================================================

/**
 * Input to `list_workflow_runs` — filter + pagination knobs, all optional.
 * Hard cap on `limit` is enforced here; the soft default (50) lives in
 * `core`. Results come back most-recent-first.
 */
export const listWorkflowRunsInputSchema = z
  .object({
    repo: z.string().min(1).optional(),
    status: z.array(workflowStatusSchema).optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();
export type ListWorkflowRunsInput = z.infer<typeof listWorkflowRunsInputSchema>;

/**
 * Output of `list_workflow_runs` — wrapped `{ runs: [...] }` so V2 can add
 * pagination metadata without breaking the wire format.
 */
export const listWorkflowRunsOutputSchema = z
  .object({
    runs: z.array(workflowRunSchema),
  })
  .strict();
export type ListWorkflowRunsOutput = z.infer<typeof listWorkflowRunsOutputSchema>;

// =====================================================================
// cancel_workflow_run
// =====================================================================

/**
 * Input to `cancel_workflow_run` — point cancel by id. Idempotent in `core`:
 * cancelling an already-terminal run is a no-op that returns current status.
 */
export const cancelWorkflowRunInputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
  })
  .strict();
export type CancelWorkflowRunInput = z.infer<typeof cancelWorkflowRunInputSchema>;

/**
 * Output of `cancel_workflow_run` — id plus the current (always-terminal)
 * status: `cancelled` for a fresh cancel, or whatever terminal state the run
 * was already in.
 */
export const cancelWorkflowRunOutputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
    status: terminalWorkflowStatusSchema,
  })
  .strict();
export type CancelWorkflowRunOutput = z.infer<typeof cancelWorkflowRunOutputSchema>;

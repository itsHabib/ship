/**
 * MCP tool I/O schemas — the wire contract between Ship's MCP server and its
 * clients. V1 tools: `ship`, `get_workflow_run`, `list_workflow_runs`,
 * `cancel_workflow_run`. All schemas are `.strict()`.
 */

import {
  artifactRefSchema,
  failureCategorySchema,
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

const shipInputModelParamEntrySchema = z
  .object({
    // Both fields require non-empty values to match the downstream
    // modelParameterValueSchema (`.min(1)`). Without this, empty-string
    // payloads pass MCP validation and fail later as a StoreSchemaError.
    id: z.string().min(1),
    value: z.union([z.string().min(1), z.boolean()]),
  })
  .strict();

/**
 * Cloud-agent config — structural twin of `CloudRunSpec` in `@ship/cursor-runner`.
 * Single-repo this phase (single-element tuple); multi-repo is a follow-up phase
 * per phase 04 § Out of scope. The runner re-validates shape with a runtime guard.
 */
export const cloudRunSpecSchema = z
  .object({
    repos: z.tuple([
      z
        .object({
          url: z.string().min(1),
          startingRef: z.string().min(1).optional(),
          prUrl: z.string().min(1).optional(),
        })
        .strict(),
    ]),
    workOnCurrentBranch: z.boolean().optional(),
    autoCreatePR: z.boolean().optional(),
    skipReviewerRequest: z.boolean().optional(),
    envVars: z.record(z.string()).optional(),
    env: z
      .object({
        type: z.enum(["cloud", "pool", "machine"]),
        name: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Rooms-agent config — structural twin of `RoomRunSpec` in `@ship/cursor-runner`.
 * Single-repo this phase (single-element tuple). The runner re-validates shape
 * with a runtime guard. No `autoCreatePR` — rooms never opens its own PR (the
 * pushed branch surfaces via `get_workflow_run`; PR opening is downstream).
 */
export const roomRunSpecSchema = z
  .object({
    repos: z.tuple([
      z
        .object({
          url: z.string().min(1),
          startingRef: z.string().min(1).optional(),
        })
        .strict(),
    ]),
    image: z.string().min(1).optional(),
    pushBranch: z.string().min(1).optional(),
  })
  .strict();

/** Input to the `ship` tool. Optional fields default in `core`. */
export const shipInputSchema = z
  .object({
    /**
     * Absolute path of the workspace the caller created. `core` runs the
     * local agent here. Optional when `runtime === "cloud"`.
     */
    workdir: z.string().min(1).optional(),
    /**
     * Path to the task doc. Relative paths resolve against `workdir`.
     * For local runs, absolute paths must realpath inside `workdir`.
     * Cloud runs skip that guard in `core`.
     */
    docPath: z.string().min(1),
    /** Repo label persisted on the workflow row; optional for cloud (auto-derived). */
    repo: z.string().min(1).optional(),
    worktreeName: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    modelParams: z.array(shipInputModelParamEntrySchema).optional(),
    /**
     * Runtime selector. Defaults to `"local"` when omitted. `"cloud"` routes
     * to the configured `CloudCursorRunner`; `"rooms"` to the configured
     * `RoomCursorRunner` (a self-hosted microVM). The matching `cloud` / `room`
     * field is required for the respective runtime (enforced by the cross-field
     * refinement below, so MCP callers get a clean schema error instead of a
     * runner-layer error after persistence).
     */
    runtime: z.enum(["local", "cloud", "rooms"]).optional(),
    /** Cloud-specific config; required when `runtime === "cloud"`, ignored otherwise. */
    cloud: cloudRunSpecSchema.optional(),
    /** Rooms-specific config; required when `runtime === "rooms"`, ignored otherwise. */
    room: roomRunSpecSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const runtime = data.runtime ?? "local";
    if (runtime === "cloud" && data.cloud === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cloud"],
        message: "cloud config is required when runtime is 'cloud'",
      });
    }
    if (runtime === "rooms" && data.room === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["room"],
        message: "room config is required when runtime is 'rooms'",
      });
    }
    // workdir + repo are required for local only. Cloud and rooms have no host
    // worktree (workdir optional) and derive `repo` from their repo URL.
    if (runtime === "local" && data.workdir === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workdir"],
        message: "workdir is required when runtime is 'local'",
      });
    }
    if (runtime === "local" && data.repo === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repo"],
        message: "repo is required when runtime is 'local'",
      });
    }
  });
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

/**
 * Output of `get_workflow_run` — hydrated `WorkflowRun` plus derived
 * cloud watch fields (omitted for local runs / before agent is recorded).
 */
const recentRunEventSchema = z.record(z.string(), z.unknown());

/**
 * One branch a terminal run produced — structural twin of `CursorRunResult.branches[]`.
 * Surfaced from `result.json` for cloud + rooms runs so downstream (`/work-driver`)
 * can read `branches[0].branch` and open the PR with `gh pr create`.
 */
export const runBranchRefSchema = z
  .object({
    repoUrl: z.string().min(1),
    branch: z.string().min(1).optional(),
    prUrl: z.string().min(1).optional(),
  })
  .strict();
export type RunBranchRef = z.infer<typeof runBranchRefSchema>;

export const getWorkflowRunOutputSchema = workflowRunSchema
  .extend({
    cursorAgentId: z.string().min(1).optional(),
    watchUrl: z.string().url().optional(),
    /** Cursor run wall time from `result.json` / cursor row (failed runs). */
    runDurationMs: z.number().int().nonnegative().optional(),
    /** Policy cap from the run row (`policy.maxRunDurationMs`), surfaced for failed runs. */
    maxRunDurationMs: z.number().int().positive().optional(),
    /** Raw SDK terminal status from `result.json` (e.g. `error`, `ERROR`). */
    sdkTerminalStatus: z.string().min(1).optional(),
    /** Tail of `events.ndjson` so operators need not open the file. */
    recentEvents: z.array(recentRunEventSchema).optional(),
    /** Branches the run pushed (cloud + rooms), from terminal `result.json`. */
    branches: z.array(runBranchRefSchema).optional(),
    /** Canonical failure classification hoisted from the implement phase row (failed runs only). */
    failureCategory: failureCategorySchema.optional(),
  })
  .superRefine((val, ctx) => {
    // Enforce the documented invariant, not just describe it: the category is
    // present iff the run failed (spec §6) — a non-failed run carrying one is a
    // producer bug, caught at the .parse sites.
    if (val.failureCategory !== undefined && val.status !== "failed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `failureCategory requires status "failed" (got "${val.status}")`,
        path: ["failureCategory"],
      });
    }
  });
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

// =====================================================================
// list_artifacts
// =====================================================================

export const listArtifactsInputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
  })
  .strict();
export type ListArtifactsInput = z.infer<typeof listArtifactsInputSchema>;

export const listArtifactsOutputSchema = z
  .object({
    artifacts: z.array(artifactRefSchema),
  })
  .strict();
export type ListArtifactsOutput = z.infer<typeof listArtifactsOutputSchema>;

// =====================================================================
// download_artifact
// =====================================================================

export const downloadArtifactInputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
    path: z.string().min(1),
    force: z.boolean().optional(),
  })
  .strict();
export type DownloadArtifactInput = z.infer<typeof downloadArtifactInputSchema>;

export const downloadArtifactOutputSchema = z
  .object({
    localPath: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type DownloadArtifactOutput = z.infer<typeof downloadArtifactOutputSchema>;

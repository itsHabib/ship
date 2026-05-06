/**
 * MCP tool I/O schemas — the wire contract between Ship's MCP server and any
 * client that talks to it (Cursor, Claude Code, the Ship CLI, etc.).
 *
 * V1 exposes four tools:
 * - `ship`                — start a workflow run from an approved task doc.
 * - `get_workflow_run`    — fetch the durable state of one run.
 * - `list_workflow_runs`  — filter / paginate the run history.
 * - `cancel_workflow_run` — cancel an in-flight run; idempotent.
 *
 * Every tool ships an input schema and an output schema. Inputs are validated
 * at the MCP boundary (untrusted caller); outputs are validated when produced
 * so we catch internal drift before it hits a client. Both ends are
 * `.strict()` — unknown keys fail loud.
 *
 * Validation seam discipline: this is also the one place ID format is
 * validated. `domain` does NOT export `validateWorkflowRunId(...)` helpers
 * (see ID-factory rationale in `id.ts`); the regex lives inline here, next
 * to the field it guards.
 */

import {
  terminalCursorRunRefSchema,
  terminalWorkflowStatusSchema,
  workflowRunSchema,
  workflowStatusSchema,
  worktreeRefSchema,
} from "@ship/workflow";
import { z } from "zod";

/**
 * Format check for `wf_<ulid>` IDs at the MCP boundary.
 *
 * A canonical ULID is 26 chars of Crockford base32 (`[0-9A-HJKMNP-TV-Z]`),
 * but the first char only encodes the top 3 bits of the 48-bit timestamp,
 * so it must be `0-7` — a leading `8-Z` is impossible for a real ULID.
 * Tightening the pattern means malformed inputs like `wf_Z...` fail the
 * boundary check instead of being passed through to `core` / `store`,
 * which would have to translate them into a "not found" later anyway.
 *
 * `core` and `store` trust the IDs they themselves generate and do not
 * re-check this; the boundary catches malformed external input.
 */
const WORKFLOW_RUN_ID_PATTERN = /^wf_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const workflowRunIdSchema = z.string().regex(WORKFLOW_RUN_ID_PATTERN);

// =====================================================================
// ship
// =====================================================================

/**
 * Input to the `ship` tool.
 *
 * Fields:
 * - `repo`         — Tower-registered repo name. Required.
 * - `docPath`      — path to the task doc, relative to the repo root.
 *                    Resolved against the repo root by `core`; symlink
 *                    escapes are rejected there, not here.
 * - `worktreeName` — optional worktree name. Defaults (in `core`) to a slug
 *                    derived from `docPath`.
 * - `baseRef`      — optional git ref to branch from. Defaults (in `core`)
 *                    to the policy `baseRef` (typically `main`).
 * - `model`        — optional Cursor model id (e.g. `"composer-2"`). Just a
 *                    string here; `cursor-runner` lifts it into a full
 *                    `ModelSelection`. Defaults (in `core`) to the config
 *                    value.
 */
export const shipInputSchema = z
  .object({
    repo: z.string().min(1),
    docPath: z.string().min(1),
    worktreeName: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();
export type ShipInput = z.infer<typeof shipInputSchema>;

/**
 * Paths to the on-disk artifacts a `ship` run produces.
 *
 * The directory itself is `CursorRunRef.artifactsDir`; this object names the
 * specific files inside. Returned in `ShipOutput` so the caller can read
 * them (CLI for printing, MCP client for resource fetches) without computing
 * paths themselves.
 *
 * Fields:
 * - `promptPath`  — absolute path to `prompt.md` (the rendered template).
 * - `eventsPath`  — absolute path to `events.ndjson` (raw SDK stream).
 * - `resultPath`  — absolute path to `result.json` (the SDK `RunResult`).
 *
 * Note: `task-doc.md` and `summary.md` also live in the same dir but are
 * not exposed here; `summary.md` content is surfaced inline as
 * `ShipOutput.summary`, and `task-doc.md` is implementation detail.
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
 * Output of the `ship` tool — the result of a single, completed run.
 *
 * Returned once the run reaches a terminal state. (Streaming responses are
 * a V2 concern; in V1 the tool blocks until the run finishes.) Both
 * `status` and `cursorRun.status` are restricted to terminal values so the
 * schema enforces this contract instead of just documenting it.
 *
 * Fields:
 * - `workflowRunId` — the `wf_<ulid>` id of this run.
 * - `status`        — terminal status: `succeeded`, `failed`, or `cancelled`.
 *                     `pending` / `running` are rejected at the boundary.
 * - `worktree`      — the Tower worktree the run executed in. Caller can
 *                     `cd` here to inspect / push / open a PR manually.
 * - `cursorRun`     — the `TerminalCursorRunRef` for the underlying SDK run.
 *                     The cursor run's own `status` must also be terminal —
 *                     a still-running ref here would mean `ship` returned
 *                     before the agent finished. Note: spec.md calls this
 *                     field `CursorRunSummary`, but the V1 type system only
 *                     ships `CursorRunRef`, which carries the same info.
 * - `artifacts`     — paths to the on-disk artifacts (see `ShipArtifacts`).
 * - `summary`       — final assistant text from the run, when present.
 *                     Contents of `summary.md`. Optional because a run that
 *                     errored out before producing a final message has none.
 */
export const shipOutputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
    status: terminalWorkflowStatusSchema,
    worktree: worktreeRefSchema,
    cursorRun: terminalCursorRunRefSchema,
    artifacts: shipArtifactsSchema,
    summary: z.string().min(1).optional(),
  })
  .strict();
export type ShipOutput = z.infer<typeof shipOutputSchema>;

// =====================================================================
// get_workflow_run
// =====================================================================

/**
 * Input to `get_workflow_run` — point lookup by id.
 *
 * The `workflowRunId` regex guards against malformed/foreign ids before
 * `core` has to look them up; a malformed id is a 4xx, not a 5xx.
 */
export const getWorkflowRunInputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
  })
  .strict();
export type GetWorkflowRunInput = z.infer<typeof getWorkflowRunInputSchema>;

/**
 * Output of `get_workflow_run` — the full hydrated `WorkflowRun` shape.
 *
 * Aliased to `workflowRunSchema` directly because the MCP output IS the
 * domain entity. We re-export it under an `OutputSchema` name so consumers
 * can read the MCP tool surface as a self-contained pair of input/output
 * schemas without hopping into `workflow.ts`.
 */
export const getWorkflowRunOutputSchema = workflowRunSchema;
export type GetWorkflowRunOutput = z.infer<typeof getWorkflowRunOutputSchema>;

// =====================================================================
// list_workflow_runs
// =====================================================================

/**
 * Input to `list_workflow_runs` — filter + pagination knobs. All optional.
 *
 * Fields:
 * - `repo`    — restrict to a single Tower-registered repo.
 * - `status`  — restrict to runs in any of these statuses.
 * - `limit`   — max number of rows to return. The schema enforces the hard
 *               cap (`max(200)`); the soft default (`50`) is applied by
 *               `core`, not by the schema, so the inferred type stays
 *               `limit?: number`.
 *
 * Ordering and offset are not in V1; runs come back most-recent-first.
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
 * Output of `list_workflow_runs` — a `runs` array containing fully hydrated
 * `WorkflowRun` shapes (same structure as `get_workflow_run`'s output).
 *
 * Wrapping in `{ runs: [...] }` (instead of returning a bare array) reserves
 * room for V2 to add pagination metadata (`nextCursor`, `total`, etc.)
 * without breaking the wire format.
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
 * Input to `cancel_workflow_run` — point cancel by id. Idempotent at the
 * `core` level: cancelling a run that's already terminal is a no-op that
 * still returns the current status.
 */
export const cancelWorkflowRunInputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
  })
  .strict();
export type CancelWorkflowRunInput = z.infer<typeof cancelWorkflowRunInputSchema>;

/**
 * Output of `cancel_workflow_run` — the id and the post-cancel status.
 *
 * Status is the *current* status after cancellation, and is always terminal:
 * - `cancelled` if the call moved a `pending` / `running` run into a
 *   terminal state.
 * - `succeeded` / `failed` / `cancelled` if the run was already terminal —
 *   the call was a no-op and we return what we found.
 *
 * `pending` / `running` are rejected at the boundary; if `core` ever
 * surfaces one of those here, that's a contract violation worth failing
 * loud instead of letting it propagate to clients.
 */
export const cancelWorkflowRunOutputSchema = z
  .object({
    workflowRunId: workflowRunIdSchema,
    status: terminalWorkflowStatusSchema,
  })
  .strict();
export type CancelWorkflowRunOutput = z.infer<typeof cancelWorkflowRunOutputSchema>;

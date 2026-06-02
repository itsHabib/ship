/**
 * Workflow domain — Zod schemas, inferred types, and state-machine helpers.
 * `WorkflowRun` is the hydrated domain shape; `store` owns row → domain
 * hydration. Per phases/02-type-system.md.
 */

import { z } from "zod";

/**
 * Lifecycle states a `WorkflowRun` can be in. Transitions encoded in
 * `canTransition`; terminals (`succeeded` | `failed` | `cancelled`) are
 * sticky.
 */
export const workflowStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

/** Lifecycle states a single `Phase` can be in. Mirrors `WorkflowStatus` in V1. */
export const phaseStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export type PhaseStatus = z.infer<typeof phaseStatusSchema>;

// Discriminator for what kind of work a `Phase` represents. "open_pr"
// is a tombstone: the verb was removed and Ship no longer writes
// `open_pr` phase rows, but the literal stays so the SQLite store can
// hydrate historical rows written before the removal. New phase kinds
// (e.g. `ci_fix`) add their own literal here.
export const phaseKindSchema = z.enum(["implement", "open_pr"]);
export type PhaseKind = z.infer<typeof phaseKindSchema>;

/**
 * Lifecycle states the underlying Cursor SDK run can be in. No `pending`:
 * the row is created when `agent.send()` resolves.
 */
export const cursorRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export type CursorRunStatus = z.infer<typeof cursorRunStatusSchema>;

/**
 * Terminal subset of `WorkflowStatus`. Duplicated (not `.extract()`-ed) so
 * `z.infer` yields a tight literal union.
 */
export const terminalWorkflowStatusSchema = z.enum(["succeeded", "failed", "cancelled"]);
export type TerminalWorkflowStatus = z.infer<typeof terminalWorkflowStatusSchema>;

/** Terminal subset of `CursorRunStatus`. */
export const terminalCursorRunStatusSchema = z.enum(["succeeded", "failed", "cancelled"]);
export type TerminalCursorRunStatus = z.infer<typeof terminalCursorRunStatusSchema>;

/** Where the underlying Cursor agent ran. Local disk vs Cursor cloud VM. */
export const cursorRunRuntimeSchema = z.enum(["local", "cloud"]);
export type CursorRunRuntime = z.infer<typeof cursorRunRuntimeSchema>;

/** One element of `ModelSelection.params`. Internal; not re-exported. */
const modelParameterValueSchema = z
  .object({
    id: z.string().min(1),
    value: z.union([z.string().min(1), z.boolean()]),
  })
  .strict();

/**
 * Identifies the Cursor model + parameter grid. Local mirror of
 * `@cursor/sdk`'s `ModelSelection`; structural-compat is asserted in
 * `@ship/cursor-runner` (per phases/05-cursor-runner.md ED-2).
 */
export const modelSelectionSchema = z
  .object({
    id: z.string().min(1),
    params: z.array(modelParameterValueSchema).optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** ISO-8601 with offset, e.g. `"2026-05-06T12:00:00Z"`. Internal helper. */
const isoDateTime = z.string().datetime({ offset: true });

/**
 * Reference to one cloud-produced artifact (SDK `SDKArtifact` shape).
 * Manifest refs only — bytes are fetched on demand via `download_artifact`.
 */
export const artifactRefSchema = z
  .object({
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: isoDateTime,
  })
  .strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

/** Sentinel value for cloud runs with no local checkout (phase 09). */
export const CLOUD_WORKTREE_SENTINEL = "(cloud)" as const;

/** Operator-facing hint when local SQLite lock contention exceeds busy_timeout. */
export const LOCAL_RUN_CONTENTION_HINT = "local run contention — reduce parallelism";

/**
 * Reference to a Tower-managed worktree. Captured at run-creation and
 * immutable for the run's lifetime.
 *
 * Fields:
 * - `repo`     — Tower-registered repo name (not a path).
 * - `name`     — worktree name within the repo; conventionally derived from
 *                the doc slug, matches the branch name for V1. Cloud runs
 *                without a local checkout use `CLOUD_WORKTREE_SENTINEL`.
 * - `branch`   — git branch the worktree is checked out on.
 * - `path`     — absolute filesystem path of the worktree, or
 *                `CLOUD_WORKTREE_SENTINEL` when no local checkout exists.
 * - `baseRef`  — the ref this worktree was branched from (typically `main`).
 */
export const worktreeRefSchema = z
  .object({
    repo: z.string().min(1),
    name: z.string().min(1),
    branch: z.string().min(1),
    path: z.string().min(1),
    baseRef: z.string().min(1),
  })
  .strict();
export type WorktreeRef = z.infer<typeof worktreeRefSchema>;

/**
 * Reference to a single Cursor SDK run. Created when `agent.send()` resolves.
 *
 * Fields:
 * - `id`           — run identifier; whether this is Ship's `cr_<ulid>` or
 *                    the SDK's run ID is settled in Phase 5 (cursor-runner).
 * - `agentId`      — the SDK's agent ID (`Agent.id`).
 * - `runtime`      — `"local"` or `"cloud"` (where the agent executed).
 * - `model`        — model + params actually used; may be absent on resume
 *                    (SDK leaves it undefined after resume).
 * - `startedAt`    — set when `agent.send()` resolves.
 * - `endedAt`      — set when the run reaches a terminal state.
 * - `status`       — current/last status from the SDK.
 * - `durationMs`   — total wall time (set on terminal); 0 is valid for
 *                    instant errors, hence `nonnegative()`.
 * - `artifactsDir` — absolute path to `<UserConfigDir>/ship/runs/<wfId>/`
 *                    holding prompt.md / events.ndjson / result.json.
 */
export const cursorRunRefSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    runtime: cursorRunRuntimeSchema,
    model: modelSelectionSchema.optional(),
    startedAt: isoDateTime,
    endedAt: isoDateTime.optional(),
    status: cursorRunStatusSchema,
    durationMs: z.number().int().nonnegative().optional(),
    artifactsDir: z.string().min(1),
    /** Cloud SDK artifact manifest (refs only). Omitted for local runs. */
    artifacts: z.array(artifactRefSchema).optional(),
  })
  .strict();
export type CursorRunRef = z.infer<typeof cursorRunRefSchema>;

/**
 * `CursorRunRef` narrowed to terminal `status`. `endedAt` / `durationMs`
 * remain optional — the status transition is the load-bearing invariant.
 */
export const terminalCursorRunRefSchema = cursorRunRefSchema.extend({
  status: terminalCursorRunStatusSchema,
});
export type TerminalCursorRunRef = z.infer<typeof terminalCursorRunRefSchema>;

/**
 * Per-run policy knobs.
 *
 * Fields:
 * - `baseRef`           — git ref the worktree branches from.
 * - `maxRunDurationMs`  — Ship-level timeout; after this Ship cancels the
 *                         run and marks the workflow `cancelled`.
 * - `agentTimeoutMs`    — SDK-level timeout passed through to `@cursor/sdk`.
 */
export const workflowPolicySchema = z
  .object({
    baseRef: z.string().min(1),
    maxRunDurationMs: z.number().int().positive(),
    agentTimeoutMs: z.number().int().positive(),
  })
  .strict();
export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;

/**
 * One unit of work inside a `WorkflowRun`. V1 always has 0 or 1 phases.
 * `inputJson` / `outputJson` are stringly-typed in V1 since only `"implement"`
 * exists; V2 turns `Phase` into a discriminated union over `kind`.
 *
 * Fields:
 * - `id`             — Ship-generated `ph_<ulid>`.
 * - `workflowRunId`  — FK back to the parent `WorkflowRun.id`.
 * - `kind`           — discriminator; `"implement"` for V1.
 * - `status`         — phase lifecycle state.
 * - `startedAt`      — absent until the phase starts.
 * - `endedAt`        — set when the phase reaches a terminal state.
 * - `cursorRunId`    — FK to the `CursorRunRef` this phase produced; only
 *                      set after `agent.send()` resolves.
 * - `inputJson`      — phase-specific JSON-encoded input; opaque here.
 * - `outputJson`     — phase-specific JSON-encoded output; opaque here.
 * - `errorMessage`   — set when `status === "failed"` (sometimes on cancel).
 */
export const phaseSchema = z
  .object({
    id: z.string().min(1),
    workflowRunId: z.string().min(1),
    kind: phaseKindSchema,
    status: phaseStatusSchema,
    startedAt: isoDateTime.optional(),
    endedAt: isoDateTime.optional(),
    cursorRunId: z.string().min(1).optional(),
    inputJson: z.string().min(1),
    outputJson: z.string().min(1).optional(),
    errorMessage: z.string().min(1).optional(),
  })
  .strict();
export type Phase = z.infer<typeof phaseSchema>;

/**
 * The top-level Ship entity. One row per `ship` invocation. This is the
 * hydrated shape — `phases` is an array, not a join.
 *
 * Fields:
 * - `id`         — Ship-generated `wf_<ulid>`.
 * - `repo`       — Tower-registered repo name; same as `worktree.repo`.
 * - `docPath`    — path to the task doc relative to the repo root.
 * - `status`     — current lifecycle state.
 * - `baseRef`    — captured separately from `policy.baseRef` so per-call
 *                  overrides don't have to rewrite the policy object.
 * - `worktree`   — projection of the Tower worktree this run executes in.
 * - `policy`     — per-run policy, often `DEFAULT_WORKFLOW_POLICY`.
 * - `createdAt`  — set when the row is first persisted.
 * - `updatedAt`  — refreshed on every status transition / phase append.
 * - `phases`     — chronological list of phases; V1 always has 0 or 1.
 */
export const workflowRunSchema = z
  .object({
    id: z.string().min(1),
    repo: z.string().min(1),
    docPath: z.string().min(1),
    status: workflowStatusSchema,
    baseRef: z.string().min(1),
    worktree: worktreeRefSchema,
    policy: workflowPolicySchema,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    phases: z.array(phaseSchema),
  })
  .strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/**
 * Fallback policy used by `core` when neither config nor a per-call override
 * supplies one. 30 min is the spike-validated upper bound for a feature-sized
 * task doc.
 */
export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  baseRef: "main",
  maxRunDurationMs: 30 * 60 * 1000,
  agentTimeoutMs: 30 * 60 * 1000,
};

/** Internal: the terminal subset of `WorkflowStatus`. */
const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Returns `true` if `status` is terminal. Advisory: `core` is the canonical
 * writer of `WorkflowRun.status`.
 */
export function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Internal: reachable `to` states from each `from`. Empty for terminals. */
const ALLOWED_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/**
 * Returns `true` iff `to` is a permitted next state from `from`. Encodes
 * spec.md § "State transitions":
 *   pending  → running, cancelled
 *   running  → succeeded, failed, cancelled
 *   <terminal> → (nothing)
 * Self-transitions return `false`. Advisory; `core` owns the canonical
 * state machine.
 */
export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Canonical Cursor cloud dashboard URL for a `bc-` agent id. Single edit
 * point if Cursor changes the `/agents/<id>` scheme.
 */
export function cursorWatchUrl(agentId: string): string {
  return `https://cursor.com/agents/${agentId}`;
}

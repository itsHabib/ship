/**
 * Workflow domain — Zod schemas, inferred types, and pure helpers.
 *
 * This file is the single source of truth for the V1 workflow data model.
 * It carries the entities Ship persists and threads through every package
 * (`store`, `tower-adapter`, `cursor-runner`, `core`, `cli`, `mcp-server`).
 *
 * Conventions used here:
 * - Every shape is declared as a `z.object(...).strict()` schema; the
 *   matching TS type is `z.infer<typeof xSchema>`. Two declarations would
 *   drift; one declaration cannot. (See task doc § ED-1.)
 * - `.strict()` is universal: unknown keys at any boundary are bugs (typos,
 *   version skew). Failing them loud beats silent stripping or pass-through.
 * - String fields use `.min(1)` because empty required strings are bugs.
 * - Timestamps are `z.string().datetime({ offset: true })` — ISO-8601 with
 *   any offset (Z, +05:30, etc.). Stricter than plain "string."
 * - Numeric duration / count fields are `int().positive()` (or `nonnegative()`
 *   where 0 is meaningful).
 *
 * `WorkflowRun` here is the **hydrated domain shape**. The `store` package
 * owns row → domain hydration; this file does not know about SQL columns.
 */

import { z } from "zod";

/**
 * Lifecycle states a `WorkflowRun` can be in.
 *
 * Transitions:
 *   pending → running → succeeded | failed | cancelled
 *   pending → cancelled        (user cancels before any phase starts)
 *
 * Terminal states (`succeeded` | `failed` | `cancelled`) are sticky — once
 * reached, no further transitions are allowed; resuming/retrying creates a
 * fresh `WorkflowRun`. See `canTransition` / `isTerminal` below.
 */
export const workflowStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

/**
 * Lifecycle states a single `Phase` can be in.
 *
 * Same value set as `WorkflowStatus` in V1 — when there's only one phase per
 * run (the "implement" phase), the run's status mirrors its phase's status.
 * V2 will introduce additional run-level states (e.g. `awaiting_review`)
 * that don't map onto a single phase, at which point this enum and
 * `WorkflowStatus` will diverge.
 */
export const phaseStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export type PhaseStatus = z.infer<typeof phaseStatusSchema>;

/**
 * Discriminator for what kind of work a `Phase` represents.
 *
 * V1 ships only `"implement"` — running the Cursor agent against an approved
 * task doc. Declared as a `z.enum(["implement"])` (not `z.literal`) so that
 * V2 phase kinds (`"open_pr"`, `"review"`, `"ci_fix"`, ...) land as a
 * single-line diff to this enum.
 */
export const phaseKindSchema = z.enum(["implement"]);
export type PhaseKind = z.infer<typeof phaseKindSchema>;

/**
 * Lifecycle states the underlying Cursor SDK run can be in.
 *
 * Note the absence of `pending`: by the time Ship has a `CursorRunRef`, the
 * SDK run has already been started — the row is created when `agent.send()`
 * resolves. Mirrors the SDK's own `RunStatus` (minus the SDK's `"finished"`,
 * which Ship surfaces as `"succeeded"` for consistency with workflow
 * vocabulary).
 */
export const cursorRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export type CursorRunStatus = z.infer<typeof cursorRunStatusSchema>;

/**
 * Terminal subset of `WorkflowStatus` — `succeeded`, `failed`, `cancelled`.
 *
 * Used at boundaries that produce only finished runs (e.g. `ship`'s output
 * after blocking until completion, `cancel_workflow_run`'s post-cancel
 * response). Lets the schema enforce the contract that those endpoints
 * never surface `pending` / `running`.
 *
 * The set is duplicated (rather than derived via `.extract()`) so the type
 * inference stays a tight literal union — `z.infer` produces
 * `"succeeded" | "failed" | "cancelled"`, not `WorkflowStatus`.
 */
export const terminalWorkflowStatusSchema = z.enum(["succeeded", "failed", "cancelled"]);
export type TerminalWorkflowStatus = z.infer<typeof terminalWorkflowStatusSchema>;

/**
 * Terminal subset of `CursorRunStatus` — `succeeded`, `failed`, `cancelled`.
 *
 * Same idea as `terminalWorkflowStatusSchema`: when a Cursor run is being
 * surfaced as a finished thing (e.g. inside `ShipOutput.cursorRun` after
 * `ship` has blocked until the agent finished), the status must not be
 * `running`.
 */
export const terminalCursorRunStatusSchema = z.enum(["succeeded", "failed", "cancelled"]);
export type TerminalCursorRunStatus = z.infer<typeof terminalCursorRunStatusSchema>;

/**
 * Where the underlying Cursor agent ran.
 *
 * V1 ships only `"local"` — the agent runs inline in the Ship process,
 * touching files on disk in a Tower worktree. V2 will add `"cloud"` (a
 * Cursor-hosted VM clones the repo and runs there). Declared as a
 * `z.enum(["local"])` so adding `"cloud"` is a one-line diff.
 */
export const cursorRunRuntimeSchema = z.enum(["local"]);
export type CursorRunRuntime = z.infer<typeof cursorRunRuntimeSchema>;

/**
 * One element of `ModelSelection.params` — a key/value picked off a model's
 * parameter grid. Internal to this file; not re-exported from `index.ts`.
 */
const modelParameterValueSchema = z
  .object({
    id: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

/**
 * Identifies the Cursor model + parameter grid to run an agent under.
 *
 * Structurally mirrors `@cursor/sdk`'s exported `ModelSelection`. We define
 * it locally instead of re-exporting from the SDK so this package keeps its
 * "no runtime SDK dependency" property — the SDK is `cursor-runner`'s
 * concern. A compile-time and runtime compatibility check lives in
 * `workflow.test.ts` to catch SDK shape drift early.
 *
 * Shape: `{ id: string; params?: Array<{ id: string; value: string }> }`.
 */
export const modelSelectionSchema = z
  .object({
    id: z.string().min(1),
    params: z.array(modelParameterValueSchema).optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * Reference to a Tower-managed worktree.
 *
 * Tower is the source of truth for worktree state; this is the projection
 * Ship stores so it can talk about the worktree without round-tripping to
 * Tower for every read. Captured at run-creation time and treated as
 * immutable for the run's lifetime.
 *
 * Fields:
 * - `repo`     — Tower-registered repo name (not a path).
 * - `name`     — worktree name within the repo. Conventionally derived from
 *                the doc slug; matches the branch name for V1.
 * - `branch`   — git branch the worktree is checked out on.
 * - `path`     — absolute filesystem path of the worktree.
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

/** ISO-8601 with offset, e.g. `"2026-05-06T12:00:00Z"`. Internal helper. */
const isoDateTime = z.string().datetime({ offset: true });

/**
 * Reference to a single Cursor SDK run that Ship spawned.
 *
 * Created when `agent.send()` resolves. Holds the metadata Ship needs to
 * reason about the run after the fact: status, model used, where artifacts
 * (events.ndjson, result.json, prompt.md) live on disk, and the SDK-side
 * agent / run identifiers used to cancel or look the run up later.
 *
 * Fields:
 * - `id`           — run identifier. See `id.ts` for the open question on
 *                    whether this is Ship's `cr_<ulid>` or the SDK's run ID;
 *                    Phase 5 (`cursor-runner`) settles it.
 * - `agentId`      — the SDK's agent ID (`Agent.id`). Useful for `Agent.list`
 *                    filtering and for resuming a run in V2.
 * - `runtime`      — `"local"` for V1; `"cloud"` arrives in V2.
 * - `model`        — the model + params the run actually executed under,
 *                    captured at finish time. May be absent on resume per
 *                    the SDK's "model is undefined after resume" gotcha.
 * - `startedAt`    — set when `agent.send()` resolves.
 * - `endedAt`      — set when the run reaches a terminal state.
 * - `status`       — current/last status from the SDK.
 * - `durationMs`   — total wall time of the run (set on terminal). 0 is
 *                    valid for instant errors, hence `nonnegative()`.
 * - `artifactsDir` — absolute path to `<UserConfigDir>/ship/runs/<wfId>/`,
 *                    where prompt.md / events.ndjson / result.json live.
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
  })
  .strict();
export type CursorRunRef = z.infer<typeof cursorRunRefSchema>;

/**
 * `CursorRunRef` narrowed to runs that have already finished — `status` must
 * be one of the terminal values.
 *
 * Used at boundaries that surface only completed runs (`ShipOutput.cursorRun`
 * after `ship` blocks until the agent finishes). Schema-level enforcement
 * means a producer that accidentally returns a still-running ref fails
 * validation at the boundary instead of the downstream consumer.
 *
 * `endedAt` and `durationMs` remain optional even here, because they're
 * populated by the runner after the terminal transition and the transition
 * itself is the load-bearing invariant. If we ever need "fully populated
 * terminal ref" semantics, that's a further refinement.
 */
export const terminalCursorRunRefSchema = cursorRunRefSchema.extend({
  status: terminalCursorRunStatusSchema,
});
export type TerminalCursorRunRef = z.infer<typeof terminalCursorRunRefSchema>;

/**
 * Per-run policy knobs.
 *
 * V1 honors only three fields. They're encoded here (rather than in
 * `core/config.ts`) because the surface is so thin that one source of truth
 * is fine. Once V2 adds richer policy (max review cycles, max CI fix
 * attempts, reviewer roster), the default likely moves to a config module
 * that layers YAML config + env + per-call overrides on top.
 *
 * Fields:
 * - `baseRef`           — git ref the worktree branches from.
 * - `maxRunDurationMs`  — Ship-level timeout. After this, Ship cancels the
 *                         run via `run.cancel()` and marks the workflow
 *                         `cancelled`. Positive integer.
 * - `agentTimeoutMs`    — SDK-level timeout passed through to `@cursor/sdk`.
 *                         Same default as `maxRunDurationMs`. Positive
 *                         integer.
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
 *
 * `inputJson` and `outputJson` are intentionally stringly-typed in V1: only
 * one `PhaseKind` exists (`"implement"`), so there's no value in
 * schema-typing the per-kind payload yet. When V2 adds `"review"` /
 * `"ci_fix"` / etc., each gets its own per-`PhaseKind` payload schema in
 * this package and `Phase` becomes a discriminated union over `kind`.
 *
 * Fields:
 * - `id`             — Ship-generated `ph_<ulid>`.
 * - `workflowRunId`  — FK back to the parent `WorkflowRun.id`.
 * - `kind`           — discriminator; `"implement"` for V1.
 * - `status`         — phase lifecycle state. Mirrors `WorkflowStatus` for
 *                      V1 since runs only have this one phase.
 * - `startedAt`      — ISO-8601 with offset; absent until the phase starts.
 * - `endedAt`        — set when the phase reaches a terminal state.
 * - `cursorRunId`    — FK to the `CursorRunRef` this phase produced (if any).
 *                      Only set after `agent.send()` resolves.
 * - `inputJson`      — phase-specific JSON-encoded input. Opaque to `domain`.
 * - `outputJson`     — phase-specific JSON-encoded output. Opaque to `domain`.
 * - `errorMessage`   — set when `status === "failed"` (or, sometimes, on
 *                      cancel) so callers can render a user-facing reason.
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
 * The top-level Ship entity. One row per `ship` invocation.
 *
 * This is the **hydrated** shape, not the SQL row: `phases` arrives as an
 * array, not a foreign-key join. The `store` package owns the row → domain
 * hydration; consumers (`core`, `mcp-server`, `cli`) only ever see this
 * shape.
 *
 * Fields:
 * - `id`         — Ship-generated `wf_<ulid>`.
 * - `repo`       — Tower-registered repo name. Same as `worktree.repo`.
 * - `docPath`    — path to the task doc relative to the repo root.
 * - `status`     — current lifecycle state. See `WorkflowStatus`.
 * - `baseRef`    — captured separately from `policy.baseRef` so a per-call
 *                  override doesn't have to rewrite the policy object.
 * - `worktree`   — projection of the Tower worktree this run executes in.
 * - `policy`     — per-run policy, often `DEFAULT_WORKFLOW_POLICY`.
 * - `createdAt`  — set when the row is first persisted.
 * - `updatedAt`  — refreshed on every status transition / phase append.
 * - `phases`     — chronological list of phases. V1 always has 0 or 1.
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
 * supplies one. 30 minutes is the spike-validated upper bound for one
 * feature-sized task doc; revise once we have real-world data.
 *
 * **Not** a "global default" in the sense of "always applied" — `core` can
 * (and should) layer YAML config + env + per-call overrides on top.
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
 * Returns `true` if `status` is a terminal state (`succeeded`, `failed`,
 * `cancelled`) — i.e. no further transitions are permitted.
 *
 * **Advisory.** `core` is the canonical writer of `WorkflowRun.status`. This
 * helper exists so `mcp-server` and `cli` can answer "is this run already
 * done?" without reaching into `core`. If `core` ever introduces a new
 * terminal state that this set doesn't know about, `core` is right and this
 * helper must be updated.
 */
export function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Internal: which `to` states are reachable from each `from` state. Encodes
 * the rules in spec.md § "State transitions". Empty arrays for terminal
 * states (no transitions out).
 */
const ALLOWED_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/**
 * Returns `true` iff `to` is a permitted next state from `from`.
 *
 * Encodes the rules in spec.md § "State transitions":
 *   pending  → running, cancelled
 *   running  → succeeded, failed, cancelled
 *   <terminal> → (nothing)
 *
 * Self-transitions (`pending → pending`, `running → running`) are not
 * meaningful and return `false`. `pending → succeeded` is forbidden — every
 * run must pass through `running` to reach a successful terminal.
 *
 * **Advisory** — same caveat as `isTerminal`. `core` owns the canonical
 * state machine.
 */
export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

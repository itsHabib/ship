/**
 * `@ship/workflow` — public barrel export.
 *
 * The workflow domain package: every Zod schema, every inferred TypeScript
 * type, every state-machine helper, and the ID factories for V1's three
 * entity kinds (`wf_<ulid>`, `ph_<ulid>`, `cr_<ulid>`).
 *
 * What this package contains:
 * - Status / kind / runtime enums for `WorkflowRun`, `Phase`, the underlying
 *   Cursor SDK run, etc.
 * - Object schemas for `WorktreeRef`, `CursorRunRef`, `WorkflowPolicy`,
 *   `Phase`, and `WorkflowRun` (the hydrated domain shape).
 * - `ModelSelection` — local mirror of `@cursor/sdk`'s exported type, kept
 *   structurally compatible by the `workflow.test.ts` satisfies test.
 * - `DEFAULT_WORKFLOW_POLICY` — the fallback policy `core` uses when no
 *   config / per-call override supplies one.
 * - `canTransition`, `isTerminal` — pure, advisory helpers encoding the
 *   spec's state-transition rules.
 * - `newWorkflowRunId`, `newPhaseId`, `newCursorRunId` — prefixed-ULID
 *   factories.
 *
 * What this package does NOT contain:
 * - MCP tool I/O schemas. Those live in `@ship/mcp`, which depends on this
 *   package for the workflow types it embeds in tool outputs.
 *
 * Consumers (`store`, `tower-adapter`, `cursor-runner`, `core`, `cli`)
 * import only from `@ship/workflow` (which resolves to this file). With
 * `verbatimModuleSyntax: true`, type-only re-exports must use
 * `export type`.
 *
 * Stability promise (within V1): any schema change — adding, removing,
 * renaming, or tightening a field — is a V1 breaking change. The PR that
 * lands the change updates every consumer in the same commit. With
 * `.strict()` everywhere, additive changes still reject objects that
 * didn't declare the new field — and that's the point.
 */

// --- workflow.ts: schemas, helpers, constants ---
export {
  canTransition,
  cursorRunRefSchema,
  cursorRunRuntimeSchema,
  cursorRunStatusSchema,
  DEFAULT_WORKFLOW_POLICY,
  isTerminal,
  modelSelectionSchema,
  phaseKindSchema,
  phaseSchema,
  phaseStatusSchema,
  workflowPolicySchema,
  workflowRunSchema,
  workflowStatusSchema,
  worktreeRefSchema,
} from "./workflow.js";

// --- workflow.ts: inferred types ---
export type {
  CursorRunRef,
  CursorRunRuntime,
  CursorRunStatus,
  ModelSelection,
  Phase,
  PhaseKind,
  PhaseStatus,
  WorkflowPolicy,
  WorkflowRun,
  WorkflowStatus,
  WorktreeRef,
} from "./workflow.js";

// --- id.ts: ID factories ---
export { newCursorRunId, newPhaseId, newWorkflowRunId } from "./id.js";

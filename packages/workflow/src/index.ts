/**
 * `@ship/workflow` — public barrel export. Schemas, inferred types,
 * state-machine helpers, ID factories. MCP tool I/O schemas live in
 * `@ship/mcp`, not here.
 */

// --- workflow.ts: schemas, helpers, constants ---
export {
  canTransition,
  CLOUD_WORKTREE_SENTINEL,
  cursorRunRefSchema,
  cursorRunRuntimeSchema,
  cursorRunStatusSchema,
  DEFAULT_WORKFLOW_POLICY,
  isTerminal,
  modelSelectionSchema,
  phaseKindSchema,
  phaseSchema,
  phaseStatusSchema,
  terminalCursorRunRefSchema,
  terminalCursorRunStatusSchema,
  terminalWorkflowStatusSchema,
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
  TerminalCursorRunRef,
  TerminalCursorRunStatus,
  TerminalWorkflowStatus,
  WorkflowPolicy,
  WorkflowRun,
  WorkflowStatus,
  WorktreeRef,
} from "./workflow.js";

// --- id.ts: ID factories ---
export { newCursorRunId, newPhaseId, newWorkflowRunId } from "./id.js";

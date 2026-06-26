/**
 * `@ship/workflow` — public barrel export. Schemas, inferred types,
 * state-machine helpers, ID factories. MCP tool I/O schemas live in
 * `@ship/mcp`, not here.
 */

// --- workflow.ts: schemas, helpers, constants ---
export {
  agentNotCreatedSentinel,
  agentProviderSchema,
  agentWatchUrl,
  artifactRefSchema,
  canTransition,
  commitCoAuthoredByTrailer,
  cursorWatchUrl,
  CLOUD_WORKTREE_SENTINEL,
  cursorRunRefSchema,
  cursorRunRuntimeSchema,
  cursorRunStatusSchema,
  DEFAULT_WORKFLOW_POLICY,
  failureCategorySchema,
  isTerminal,
  LOCAL_RUN_CONTENTION_HINT,
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
  AgentProvider,
  ArtifactRef,
  CursorRunRef,
  CursorRunRuntime,
  CursorRunStatus,
  FailureCategory,
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

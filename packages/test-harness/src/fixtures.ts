/**
 * Reusable test fixtures and `*Input` builders for scenarios. Frozen at module
 * load — tests that need a tweaked variant should spread, not mutate.
 */

import type { AppendPhaseInput, CreateWorkflowRunInput, RecordCursorRunInput } from "@ship/store";
import type { WorkflowPolicy, WorktreeRef } from "@ship/workflow";

/** Sample task doc body fed to the prompt template. */
export const sampleTaskDoc: string = [
  "# Sample task",
  "",
  "Add a `hello` function and a test for it.",
  "",
  "## Acceptance criteria",
  "- `pnpm test` passes.",
  "- `hello()` returns `'world'`.",
].join("\n");

/** Sample `WorktreeRef` mirroring Tower's shape for a worktree off `main`. */
export const sampleWorktree: Readonly<WorktreeRef> = Object.freeze({
  baseRef: "main",
  branch: "ship/sample-task",
  name: "sample-task",
  path: "/repo/.worktrees/sample-task",
  repo: "ship",
});

/** Sample `WorkflowPolicy`. Matches `DEFAULT_WORKFLOW_POLICY`. */
export const samplePolicy: Readonly<WorkflowPolicy> = Object.freeze({
  agentTimeoutMs: 30 * 60 * 1000,
  baseRef: "main",
  maxRunDurationMs: 30 * 60 * 1000,
});

/** Builds a `CreateWorkflowRunInput` with canonical sample data. */
export function createSampleWorkflowRunInput(
  id: string,
  overrides: Partial<CreateWorkflowRunInput> = {},
): CreateWorkflowRunInput {
  return {
    baseRef: "main",
    docPath: "docs/features/sample-task.md",
    id,
    policy: { ...samplePolicy },
    repo: "ship",
    worktree: { ...sampleWorktree },
    ...overrides,
  };
}

/** Builds an `AppendPhaseInput` with canonical sample data (V1 `implement` shape). */
export function createSampleAppendPhaseInput(
  id: string,
  workflowRunId: string,
  overrides: Partial<AppendPhaseInput> = {},
): AppendPhaseInput {
  return {
    id,
    inputJson: JSON.stringify({
      baseRef: "main",
      docPath: "docs/features/sample-task.md",
      repo: "ship",
    }),
    kind: "implement",
    workflowRunId,
    ...overrides,
  };
}

/** Builds a `RecordCursorRunInput` with canonical sample data. */
export function createSampleRecordCursorRunInput(
  id: string,
  workflowRunId: string,
  overrides: Partial<RecordCursorRunInput> = {},
): RecordCursorRunInput {
  return {
    agentId: "agent_sample",
    artifactsDir: `/runs/${workflowRunId}`,
    id,
    runtime: "local",
    workflowRunId,
    ...overrides,
  };
}

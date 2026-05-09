/**
 * Reusable test fixtures for `@ship/test-harness` consumers.
 *
 * Every scenario test reaches for the same handful of "valid sample"
 * entities — a worktree ref, a workflow policy, a task doc string, and the
 * corresponding `*Input` shapes the store accepts. Centralizing them here
 * keeps test bodies focused on the behavior under test rather than
 * boilerplate fixture construction, and makes it impossible for two
 * scenarios to disagree on what "the canonical sample" looks like.
 *
 * All fixtures are deeply frozen at module load (`Object.freeze` recursively
 * via the helper below). Tests that need a tweaked variant should spread:
 *
 * ```ts
 * const customWorktree = { ...sampleWorktree, repo: "other" };
 * ```
 *
 * not mutate the fixture in place.
 */

import type { AppendPhaseInput, CreateWorkflowRunInput, RecordCursorRunInput } from "@ship/store";
import type { WorkflowPolicy, WorktreeRef } from "@ship/workflow";

/** Sample task doc body; what `core` will eventually feed to the prompt template. */
export const sampleTaskDoc: string = [
  "# Sample task",
  "",
  "Add a `hello` function and a test for it.",
  "",
  "## Acceptance criteria",
  "- `pnpm test` passes.",
  "- `hello()` returns `'world'`.",
].join("\n");

/**
 * Sample `WorktreeRef`. Mirrors the shape Tower returns for a worktree
 * branched off `main` under `<repo>/.worktrees/<name>`. The `path` is
 * intentionally Unix-style; tests that exercise Windows path handling
 * should construct their own.
 */
export const sampleWorktree: Readonly<WorktreeRef> = Object.freeze({
  baseRef: "main",
  branch: "ship/sample-task",
  name: "sample-task",
  path: "/repo/.worktrees/sample-task",
  repo: "ship",
});

/** Sample `WorkflowPolicy`. Matches `DEFAULT_WORKFLOW_POLICY` from `@ship/workflow`. */
export const samplePolicy: Readonly<WorkflowPolicy> = Object.freeze({
  agentTimeoutMs: 30 * 60 * 1000,
  baseRef: "main",
  maxRunDurationMs: 30 * 60 * 1000,
});

/**
 * Builds a `CreateWorkflowRunInput` with the canonical sample data, so
 * scenarios don't repeat the assembly. Caller passes the run id (typically
 * `harness.ids.workflowRun()`).
 *
 * Spread to override fields:
 * ```ts
 * createSampleWorkflowRunInput(id, { repo: "tower" })
 * ```
 */
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

/**
 * Builds an `AppendPhaseInput` with canonical sample data. Caller passes
 * the phase + parent ids; everything else is the V1 `implement` shape.
 */
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

/**
 * Builds a `RecordCursorRunInput` with canonical sample data. The
 * `artifactsDir` is intentionally not a real path; tests don't write to it.
 */
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

/**
 * Per-run artifact paths. Spec.md § ED-4 pins the layout; this file
 * is the only place those names live in code.
 */

import { join } from "node:path";

/** File names inside `<runsDir>/<workflowRunId>/`. */
export const ARTIFACT_FILES = {
  prompt: "prompt.md",
  taskDoc: "task-doc.md",
  events: "events.ndjson",
  result: "result.json",
  summary: "summary.md",
} as const;

export type ArtifactName = keyof typeof ARTIFACT_FILES;

export interface RunArtifactPaths {
  readonly dir: string;
  readonly prompt: string;
  readonly taskDoc: string;
  readonly events: string;
  readonly result: string;
  readonly summary: string;
}

export function resolveRunArtifactsDir(runsDir: string, workflowRunId: string): string {
  return join(runsDir, workflowRunId);
}

export function resolveRunArtifactPaths(runsDir: string, workflowRunId: string): RunArtifactPaths {
  const dir = resolveRunArtifactsDir(runsDir, workflowRunId);
  return {
    dir,
    prompt: join(dir, ARTIFACT_FILES.prompt),
    taskDoc: join(dir, ARTIFACT_FILES.taskDoc),
    events: join(dir, ARTIFACT_FILES.events),
    result: join(dir, ARTIFACT_FILES.result),
    summary: join(dir, ARTIFACT_FILES.summary),
  };
}

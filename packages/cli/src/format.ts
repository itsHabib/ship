/**
 * Output formatters for the four `ship` subcommands. Each shape has
 * a pretty (default) and `--json` variant; pretty mode is plain ASCII
 * (no ANSI colors in V1) so test snapshots are stable across terminals.
 */

import type { OpenPrOutput, ShipOutput } from "@ship/core";
import type { CursorRunRef, WorkflowRun, WorkflowStatus } from "@ship/workflow";

/** Renders a `ShipOutput` for the `ship ship` subcommand. */
export function formatShipOutput(out: ShipOutput, json: boolean): string {
  if (json) return jsonStringify(out);
  const lines = [`status:        ${out.status}`, `workflowRunId: ${out.workflowRunId}`];
  if (out.summary !== undefined && out.summary !== "") lines.push(`summary:       ${out.summary}`);
  lines.push(
    "artifacts:",
    `  prompt:  ${out.artifacts.promptPath}`,
    `  events:  ${out.artifacts.eventsPath}`,
    `  result:  ${out.artifacts.resultPath}`,
  );
  return lines.join("\n");
}

/** Renders a hydrated `WorkflowRun` for the `ship status` subcommand. */
export function formatWorkflowRun(run: WorkflowRun, json: boolean): string {
  if (json) return jsonStringify(run);
  const lines = [
    `id:        ${run.id}`,
    `status:    ${run.status}`,
    `repo:      ${run.worktree.repo}`,
    `docPath:   ${run.docPath}`,
    `worktree:  ${run.worktree.path}`,
    `createdAt: ${run.createdAt}`,
    `updatedAt: ${run.updatedAt}`,
  ];
  if (run.phases.length > 0) {
    lines.push("phases:");
    for (const phase of run.phases) {
      const tail = phase.errorMessage !== undefined ? ` (${phase.errorMessage})` : "";
      lines.push(`  - ${phase.kind}: ${phase.status}${tail}`);
    }
  }
  return lines.join("\n");
}

/** Renders a list of `WorkflowRun` rows for the `ship list` subcommand. */
export function formatWorkflowRunList(runs: readonly WorkflowRun[], json: boolean): string {
  if (json) return jsonStringify({ runs });
  const header = `${pad("ID", 32)}  ${pad("STATUS", 10)}  ${pad("REPO", 24)}  ${pad("CREATED", 25)}  UPDATED`;
  if (runs.length === 0) return header;
  const rows = runs.map(
    (r) =>
      `${pad(r.id, 32)}  ${pad(r.status, 10)}  ${pad(r.worktree.repo, 24)}  ${pad(r.createdAt, 25)}  ${r.updatedAt}`,
  );
  return [header, ...rows].join("\n");
}

/** Renders a `cancelRun` result for the `ship cancel` subcommand. */
export function formatCancelOutput(
  out: { workflowRunId: string; status: WorkflowStatus },
  json: boolean,
): string {
  if (json) return jsonStringify(out);
  return `status: ${out.status}\nworkflowRunId: ${out.workflowRunId}`;
}

/** Renders an `OpenPrOutput` for the `ship open-pr` subcommand. */
export function formatOpenPrOutput(out: OpenPrOutput, json: boolean): string {
  if (json) return jsonStringify(out);
  const lines = [
    `status:        ${out.status}`,
    `workflowRunId: ${out.workflowRunId}`,
    `phaseId:       ${out.phaseId}`,
    `prNumber:      ${String(out.prNumber)}`,
    `prUrl:         ${out.prUrl}`,
    `base:          ${out.base}`,
    `head:          ${out.head}`,
    `alreadyExisted: ${String(out.alreadyExisted)}`,
  ];
  return lines.join("\n");
}

/** Pretty-prints a terminal cursor-run summary; used by `ship ship` in pretty mode. */
export function summarizeCursorRun(ref: CursorRunRef): string {
  return `${ref.id} (${ref.status}, ${ref.runtime})`;
}

function pad(value: string, width: number): string {
  if (value.length >= width) return `${value.slice(0, Math.max(0, width - 1))}…`;
  return value + " ".repeat(width - value.length);
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

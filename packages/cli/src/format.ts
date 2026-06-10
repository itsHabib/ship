// Output formatters for the `ship` subcommands. Each shape has a pretty
// (default) and `--json` variant; pretty mode is plain ASCII (no ANSI
// colors in V1) so test snapshots are stable across terminals.

import type { PruneRunsOutput, ShipOutput } from "@ship/core";
import type { CursorRunRef, WorkflowRun, WorkflowStatus } from "@ship/workflow";

import { formatPruneAge } from "@ship/core";

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

/** Renders a `pruneRuns` result for the `ship prune` subcommand. */
export function formatPruneOutput(out: PruneRunsOutput, json: boolean): string {
  if (json) return jsonStringify(out);
  if (out.targets.length === 0) {
    return out.dryRun ? "dry-run: (none)" : "pruned: (none)";
  }
  const header = `${pad("RUN ID", 32)}  ${pad("STATUS", 10)}  AGE`;
  const rows = out.targets.map(
    (t) =>
      `${pad(t.runId, 32)}  ${pad(t.status, 10)}  ${t.status === "orphan" ? "orphan" : formatPruneAge(t.ageMs)}`,
  );
  const prefix = out.dryRun ? "dry-run:\n" : "pruned:\n";
  const body = `${prefix}${[header, ...rows].join("\n")}`;
  if (out.failures.length === 0) return body;
  return `${body}\nfailed/skipped (${String(out.failures.length)}): ${out.failures.join(", ")}`;
}

/** Renders a `cancelRun` result for the `ship cancel` subcommand. */
export function formatCancelOutput(
  out: { workflowRunId: string; status: WorkflowStatus },
  json: boolean,
): string {
  if (json) return jsonStringify(out);
  return `status: ${out.status}\nworkflowRunId: ${out.workflowRunId}`;
}

// Pretty-prints a terminal cursor-run summary; used by `ship ship` in pretty mode.
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

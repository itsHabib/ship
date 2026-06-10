// Output formatters for the `ship` subcommands. Each shape has a pretty
// (default) and `--json` variant; pretty mode is plain ASCII (no ANSI
// colors in V1) so test snapshots are stable across terminals.

import type { GetWorkflowRunOutput, ShipOutput } from "@ship/core";
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

function implementPhaseErrorMessage(run: WorkflowRun): string | undefined {
  const phase = run.phases.find((p) => p.kind === "implement");
  return phase?.errorMessage;
}

function renderToolCallActivity(ev: Record<string, unknown>): string {
  const name = typeof ev["name"] === "string" ? ev["name"] : "tool";
  const status = typeof ev["status"] === "string" ? ev["status"] : "unknown";
  const ts = typeof ev["ts"] === "string" ? ev["ts"] : undefined;
  if (ts !== undefined) return `${name} ${status} (${ts})`;
  return `${name} ${status}`;
}

function renderLastActivity(
  recentEvents: readonly Record<string, unknown>[] | undefined,
): string | undefined {
  if (recentEvents === undefined || recentEvents.length === 0) return undefined;
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    const ev = recentEvents[i];
    if (ev?.["type"] === "tool_call") return renderToolCallActivity(ev);
  }
  const last = recentEvents[recentEvents.length - 1];
  if (last !== undefined && typeof last["type"] === "string") return last["type"];
  return undefined;
}

function formatDurationVsCap(
  runDurationMs: number | undefined,
  maxRunDurationMs: number | undefined,
): string | undefined {
  if (runDurationMs !== undefined && maxRunDurationMs !== undefined) {
    return `${String(runDurationMs)}ms / cap ${String(maxRunDurationMs)}ms`;
  }
  if (runDurationMs !== undefined) return `${String(runDurationMs)}ms`;
  if (maxRunDurationMs !== undefined) return `cap ${String(maxRunDurationMs)}ms`;
  return undefined;
}

/** Renders diagnosis fields for the `ship diagnose` subcommand. */
export function formatDiagnoseRun(run: GetWorkflowRunOutput, json: boolean): string {
  if (json) return jsonStringify(run);
  const lines = [`status:    ${run.status}`, `id:        ${run.id}`];
  if (run.status !== "failed") {
    lines.push("note:      nothing to diagnose");
    return lines.join("\n");
  }
  // "(unclassified)" distinguishes a pre-P1 row (failure_category NULL) from
  // the real `unknown` category — absent is not the same as unclassifiable.
  lines.push(`category:  ${run.failureCategory ?? "(unclassified)"}`);
  const errorMessage = implementPhaseErrorMessage(run);
  if (errorMessage !== undefined) lines.push(`error:     ${errorMessage}`);
  const duration = formatDurationVsCap(run.runDurationMs, run.maxRunDurationMs);
  if (duration !== undefined) lines.push(`duration:  ${duration}`);
  if (run.sdkTerminalStatus !== undefined) lines.push(`sdkStatus: ${run.sdkTerminalStatus}`);
  const lastActivity = renderLastActivity(run.recentEvents);
  if (lastActivity !== undefined) lines.push(`last:      ${lastActivity}`);
  if (run.watchUrl !== undefined) lines.push(`watchUrl:  ${run.watchUrl}`);
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

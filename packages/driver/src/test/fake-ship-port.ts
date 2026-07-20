/**
 * Scripted fake `DriverShipPort` for engine L1/L2 tests.
 */

import type { GetWorkflowRunOutput, ShipInput, ShipStartOutput } from "@ship/core";
import type { ListRunsFilter } from "@ship/store";
import type { WorkflowRun } from "@ship/workflow";

import { DEFAULT_WORKFLOW_POLICY } from "@ship/workflow";

import type { DriverShipPort } from "../ship-port.js";

export interface FakeRunScript {
  workflowRunId: string;
  docPath: string;
  branch?: string;
  repo: string;
  terminalStatus?: GetWorkflowRunOutput["status"];
  failureCategory?: GetWorkflowRunOutput["failureCategory"];
  /** Persisted on the implement phase — feeds the §4.7 poll-seam shape sensor. */
  errorMessage?: string;
  prUrl?: string;
  branchName?: string;
  throwOnStart?: Error;
}

export interface FakeShipPortCall {
  kind: "startShip" | "getRun" | "listRuns" | "cancelRun" | "refreshOrphanedRuns";
  input?: ShipInput | ListRunsFilter | string;
}

export function createFakeShipPort(
  scripts: FakeRunScript[] = [],
  clock?: () => number,
): {
  port: DriverShipPort;
  calls: FakeShipPortCall[];
  runs: Map<string, GetWorkflowRunOutput>;
} {
  const calls: FakeShipPortCall[] = [];
  const runs = new Map<string, GetWorkflowRunOutput>();
  const dispatchCounts = new Map<string, number>();
  const now = (): string => new Date((clock ?? Date.now)()).toISOString();
  let nextId = 0;

  for (const script of scripts) {
    runs.set(script.workflowRunId, buildRun(script, now));
  }

  const port: DriverShipPort = {
    cancelRun: (workflowRunId) => {
      calls.push({ input: workflowRunId, kind: "cancelRun" });
      const run = runs.get(workflowRunId);
      if (run !== undefined) {
        runs.set(workflowRunId, { ...run, status: "cancelled" });
      }
      return Promise.resolve({ status: "cancelled", workflowRunId });
    },
    getRun: (workflowRunId) => {
      calls.push({ input: workflowRunId, kind: "getRun" });
      return Promise.resolve(runs.get(workflowRunId) ?? null);
    },
    listRuns: (filter) => {
      calls.push({ input: filter, kind: "listRuns" });
      return Promise.resolve(filterRuns([...runs.values()], filter));
    },
    refreshOrphanedRuns: () => {
      calls.push({ kind: "refreshOrphanedRuns" });
      return Promise.resolve();
    },
    startShip: (input) => {
      calls.push({ input, kind: "startShip" });
      return Promise.resolve(
        startFakeShip(input, scripts, runs, dispatchCounts, { nextId: () => nextId++, now }),
      );
    },
  };

  return { calls, port, runs };
}

function filterRuns(all: WorkflowRun[], filter: ListRunsFilter): WorkflowRun[] {
  return all.filter((run) => {
    if (filter.repo !== undefined && run.repo !== filter.repo) return false;
    if (filter.status !== undefined && !filter.status.includes(run.status)) return false;
    return true;
  });
}

function pickScript(
  input: ShipInput,
  scripts: FakeRunScript[],
  dispatchCounts: Map<string, number>,
): FakeRunScript | undefined {
  const count = dispatchCounts.get(input.docPath) ?? 0;
  const matches = scripts.filter((s) => s.docPath === input.docPath);
  const match = matches[count] ?? matches.at(-1);
  dispatchCounts.set(input.docPath, count + 1);
  return match;
}

function startFakeShip(
  input: ShipInput,
  scripts: FakeRunScript[],
  runs: Map<string, GetWorkflowRunOutput>,
  dispatchCounts: Map<string, number>,
  helpers: { nextId: () => number; now: () => string },
): ShipStartOutput {
  const match = pickScript(input, scripts, dispatchCounts);
  if (match?.throwOnStart !== undefined) {
    throw match.throwOnStart;
  }

  const workflowRunId = match?.workflowRunId ?? `wf_fake_${String(helpers.nextId())}`;
  const branch = input.branch ?? match?.branch ?? "main";
  const script = buildScript(input, match, branch, workflowRunId);
  runs.set(workflowRunId, buildRun(script, helpers.now));
  return { status: "running", workflowRunId };
}

function buildScript(
  input: ShipInput,
  match: FakeRunScript | undefined,
  branch: string,
  workflowRunId: string,
): FakeRunScript {
  const base: FakeRunScript = {
    branch,
    branchName: match?.branchName ?? branch,
    docPath: input.docPath,
    repo: input.repo ?? match?.repo ?? "ship",
    terminalStatus: match?.terminalStatus ?? "succeeded",
    workflowRunId,
  };
  return mergeOptionalScriptFields(base, match);
}

function mergeOptionalScriptFields(
  base: FakeRunScript,
  match: FakeRunScript | undefined,
): FakeRunScript {
  if (match === undefined) return base;
  const category = match.failureCategory;
  const prUrl = match.prUrl;
  const errorMessage = match.errorMessage;
  let next = base;
  if (category !== undefined) next = { ...next, failureCategory: category };
  if (prUrl !== undefined) next = { ...next, prUrl };
  if (errorMessage !== undefined) next = { ...next, errorMessage };
  return next;
}

function buildRun(script: FakeRunScript, now: () => string): GetWorkflowRunOutput {
  const status = script.terminalStatus ?? "succeeded";
  const branch = script.branch ?? script.branchName ?? "main";
  const failure = failedRunExtras(script, status, now);
  const run: GetWorkflowRunOutput = {
    baseRef: "main",
    createdAt: now(),
    docPath: script.docPath,
    id: script.workflowRunId,
    phases: failure.phases,
    policy: DEFAULT_WORKFLOW_POLICY,
    repo: script.repo,
    status,
    updatedAt: now(),
    worktree: {
      baseRef: "main",
      branch,
      name: branch,
      path: `/worktrees/${branch}`,
      repo: script.repo,
    },
    ...(failure.failureCategory !== undefined ? { failureCategory: failure.failureCategory } : {}),
  };
  // Any status may carry a PR (cloud autoPR then failure) — mirror that.
  if (script.prUrl !== undefined) {
    return {
      ...run,
      branches: [
        {
          branch: script.branchName ?? branch,
          prUrl: script.prUrl,
          repoUrl: "https://github.com/example/ship",
        },
      ],
    };
  }
  return run;
}

function failedRunExtras(
  script: FakeRunScript,
  status: GetWorkflowRunOutput["status"],
  now: () => string,
): {
  phases: GetWorkflowRunOutput["phases"];
  failureCategory?: GetWorkflowRunOutput["failureCategory"];
} {
  if (status !== "failed") return { phases: [] };
  if (script.errorMessage === undefined && script.failureCategory === undefined) {
    return { phases: [] };
  }
  const ts = now();
  return {
    phases: [
      {
        endedAt: ts,
        id: `ph_${script.workflowRunId}`,
        inputJson: "{}",
        kind: "implement",
        startedAt: ts,
        status: "failed",
        workflowRunId: script.workflowRunId,
        ...(script.errorMessage !== undefined ? { errorMessage: script.errorMessage } : {}),
        ...(script.failureCategory !== undefined
          ? { failureCategory: script.failureCategory }
          : {}),
      },
    ],
    ...(script.failureCategory !== undefined ? { failureCategory: script.failureCategory } : {}),
  };
}

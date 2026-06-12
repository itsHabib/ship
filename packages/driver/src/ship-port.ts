/**
 * Narrow ship port for the driver engine (ED-1).
 */

import type { GetWorkflowRunOutput, ListRunsFilter, ShipInput, ShipStartOutput } from "@ship/core";
import type { WorkflowRun } from "@ship/workflow";

export interface DriverShipPort {
  startShip: (input: ShipInput) => Promise<ShipStartOutput>;
  getRun: (workflowRunId: string) => Promise<GetWorkflowRunOutput | null>;
  listRuns: (filter: ListRunsFilter) => Promise<WorkflowRun[]>;
  cancelRun: (
    workflowRunId: string,
  ) => Promise<{ workflowRunId: string; status: WorkflowRun["status"] }>;
}

export type { GetWorkflowRunOutput, ListRunsFilter, ShipInput, ShipStartOutput };

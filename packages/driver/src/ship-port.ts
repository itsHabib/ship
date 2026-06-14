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
  /**
   * Re-attach orphaned cloud runs so a tick after a process kill can harvest
   * their terminal result. Optional: ports that never orphan (the engine L1
   * fakes) may omit it; `run` invokes it only when present. The underlying
   * `ShipService` re-attach is staleness-guarded, so this never disturbs a
   * sibling process's live run.
   */
  resumeOrphanedRuns?: () => Promise<void>;
}

export type { GetWorkflowRunOutput, ListRunsFilter, ShipInput, ShipStartOutput };

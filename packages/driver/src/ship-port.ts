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
   * Non-streaming, one-shot refresh of orphaned cloud runs so a tick after a
   * process kill can harvest their terminal result WITHOUT holding the
   * short-lived CLI process open. Reads each orphan's current state once (no
   * SDK event stream, heartbeat pump, or duration-cap timer) and finalizes only
   * the terminal ones; a still-running orphan is left untouched for a later
   * tick. Optional: ports that never orphan (the engine L1 fakes) may omit it;
   * `run` invokes it only when present. The underlying `ShipService` refresh is
   * staleness-guarded, so this never disturbs a sibling process's live run.
   *
   * Prefer this over the streaming `resumeOrphanedRuns` in the driver tick: the
   * latter's ref'd pump / cap timer / SDK socket outlive `--max-wait 0`.
   */
  refreshOrphanedRuns?: () => Promise<void>;
}

export type { GetWorkflowRunOutput, ListRunsFilter, ShipInput, ShipStartOutput };

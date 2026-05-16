/** Smoke test for the barrel. Pins that consumers' imports actually resolve. */

import { describe, expect, test } from "vitest";

import * as workflow from "./index.js";

describe("@ship/workflow barrel export (index.ts)", () => {
  test("re-exports the workflow runtime values", () => {
    expect(typeof workflow.workflowStatusSchema.parse).toBe("function");
    expect(typeof workflow.canTransition).toBe("function");
    expect(typeof workflow.isTerminal).toBe("function");
    expect(workflow.DEFAULT_WORKFLOW_POLICY.baseRef).toBe("main");
  });

  test("re-exports the ID factories", () => {
    expect(workflow.newWorkflowRunId().startsWith("wf_")).toBe(true);
    expect(workflow.newPhaseId().startsWith("ph_")).toBe(true);
    expect(workflow.newCursorRunId().startsWith("cr_")).toBe(true);
  });

  test("re-exports the open_pr phase result schema", () => {
    expect(typeof workflow.phaseOpenPrResultSchema.parse).toBe("function");
  });
});

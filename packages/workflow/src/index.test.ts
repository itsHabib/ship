/**
 * Smoke test for `index.ts` (the package's public barrel).
 *
 * The other test files exercise modules directly. This file verifies that
 * the barrel re-exports what consumers will import — a typo in the barrel
 * would otherwise only surface in a downstream package, with a worse
 * error message.
 */

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
});

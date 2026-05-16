/** Smoke test verifying the barrel re-exports every schema. */

import { describe, expect, test } from "vitest";

import * as mcp from "./index.js";

describe("@ship/mcp barrel export (index.ts)", () => {
  test("re-exports every MCP tool I/O schema", () => {
    expect(typeof mcp.shipInputSchema.parse).toBe("function");
    expect(typeof mcp.shipOutputSchema.parse).toBe("function");
    expect(typeof mcp.shipArtifactsSchema.parse).toBe("function");
    expect(typeof mcp.getWorkflowRunInputSchema.parse).toBe("function");
    expect(typeof mcp.getWorkflowRunOutputSchema.parse).toBe("function");
    expect(typeof mcp.listWorkflowRunsInputSchema.parse).toBe("function");
    expect(typeof mcp.listWorkflowRunsOutputSchema.parse).toBe("function");
    expect(typeof mcp.cancelWorkflowRunInputSchema.parse).toBe("function");
    expect(typeof mcp.cancelWorkflowRunOutputSchema.parse).toBe("function");
    expect(typeof mcp.thinkingEffortSchema.parse).toBe("function");
    expect(typeof mcp.openPrInputSchema.parse).toBe("function");
    expect(typeof mcp.openPrOutputSchema.parse).toBe("function");
    expect(typeof mcp.phaseIdSchema.parse).toBe("function");
  });
});

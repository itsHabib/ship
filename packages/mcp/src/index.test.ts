/**
 * Smoke test for `index.ts` (the package's public barrel).
 *
 * The `mcp.test.ts` file exercises each schema directly. This file just
 * verifies the barrel re-exports what consumers will import — a typo here
 * would otherwise surface in `mcp-server` or `core` with a worse error.
 */

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
  });
});

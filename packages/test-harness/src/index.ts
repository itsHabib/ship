/**
 * `@ship/test-harness` — public barrel export. Dev-only package consumed via
 * `devDependencies` from every other Ship package's tests.
 */

// --- harness.ts ---
export type {
  CreateHarnessOptions,
  CreateServiceFromHarnessOptions,
  Harness,
  ServiceBundle,
} from "./harness.js";
export { createHarness, createServiceFromHarness } from "./harness.js";
export { FakeDocSource } from "./fake-doc-source.js";

// --- clock.ts ---
export type { TestClock } from "./clock.js";
export { createTestClock } from "./clock.js";

// --- fixtures.ts ---
export {
  createSampleAppendPhaseInput,
  createSampleRecordCursorRunInput,
  createSampleWorkflowRunInput,
  samplePolicy,
  sampleTaskDoc,
  sampleWorktree,
} from "./fixtures.js";

// --- mcp.ts ---
export type { ToolCaller, WaitForTerminalRunOptions } from "./mcp.js";
export { waitForTerminalRun } from "./mcp.js";

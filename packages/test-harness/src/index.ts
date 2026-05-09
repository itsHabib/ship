/**
 * `@ship/test-harness` — public barrel export.
 *
 * Dev-only package consumed via `devDependencies` from every other Ship
 * package's tests. Provides:
 *
 * - `createHarness({ dbPath?, clockStart?, clockStepMs? })` — assembles a
 *   `Harness` with a `@ship/store` instance, a deterministic test clock,
 *   prefixed-ULID id factories, and a `close()` for lifecycle.
 * - `createTestClock(start, stepMs?)` — the standalone clock helper used
 *   inside the harness; useful in unit tests that don't need a full
 *   harness but still want a deterministic `() => string`.
 * - Fixtures (`sampleWorktree`, `samplePolicy`, `sampleTaskDoc`) and
 *   per-input builders (`createSample*Input`) — the canonical "valid
 *   sample" data scenarios reach for instead of re-declaring fixtures
 *   per test.
 *
 * What this package does NOT contain:
 * - Per-package fakes (`FakeCursorRunner`, `FakeTowerAdapter`, ...). Those
 *   ship from their host packages so the fake stays in step with the real
 *   implementation. The harness imports them via `devDependencies` as
 *   they land in phases 5–6.
 * - E2E-test scaffolding. That lives at the top-level `e2e/` directory.
 *
 * Stability promise (within V1): any rename or signature change is a
 * breaking change. The package is dev-only, so no production consumers
 * are affected; downstream tests that rely on it are updated in the same
 * commit.
 */

// --- harness.ts ---
export type { CreateHarnessOptions, Harness } from "./harness.js";
export { createHarness } from "./harness.js";

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

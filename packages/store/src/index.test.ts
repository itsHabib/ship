/**
 * Smoke test for the public barrel. Pins the exported surface; type
 * re-exports are validated by the `import type` block alone (a missing
 * name fails typecheck, which gates the test run).
 */

import { describe, expect, test } from "vitest";

import type {
  AppendPhaseInput,
  CreateStoreOptions,
  CreateWorkflowRunInput,
  ListRunsFilter,
  RecordCursorRunInput,
  Store,
  UpdateCursorRunInput,
  UpdatePhaseInput,
} from "./index.js";

import {
  createStore,
  CursorRunNotFoundError,
  MigrationError,
  PhaseNotFoundError,
  StoreSchemaError,
  WorkflowRunNotFoundError,
} from "./index.js";

// Compile-time reference so an autofixer can't strip the type imports.
type _Surface = readonly [
  CreateStoreOptions,
  CreateWorkflowRunInput,
  ListRunsFilter,
  AppendPhaseInput,
  UpdatePhaseInput,
  RecordCursorRunInput,
  UpdateCursorRunInput,
  Store,
];

describe("@ship/store barrel exports", () => {
  test("createStore returns a Store with every documented method present", () => {
    const store = createStore({ dbPath: ":memory:" });
    try {
      const expected: readonly (keyof Store)[] = [
        "createWorkflowRun",
        "updateWorkflowRunStatus",
        "appendPhase",
        "updatePhase",
        "recordCursorRun",
        "updateCursorRunStatus",
        "getCursorRun",
        "getRun",
        "listRuns",
        "cancelRun",
        "close",
      ];
      for (const method of expected) {
        expect(typeof store[method]).toBe("function");
      }
    } finally {
      store.close();
    }
  });

  test("typed errors are runtime-instantiable Error subclasses with discriminating names", () => {
    expect(new CursorRunNotFoundError("cr_x")).toBeInstanceOf(Error);
    expect(new MigrationError("0001.sql", "boom")).toBeInstanceOf(Error);
    expect(new PhaseNotFoundError("ph_x")).toBeInstanceOf(Error);
    expect(new StoreSchemaError("bad json")).toBeInstanceOf(Error);
    expect(new WorkflowRunNotFoundError("wf_x")).toBeInstanceOf(Error);

    expect(new CursorRunNotFoundError("cr_x").name).toBe("CursorRunNotFoundError");
    expect(new MigrationError("0001.sql", "boom").name).toBe("MigrationError");
    expect(new PhaseNotFoundError("ph_x").name).toBe("PhaseNotFoundError");
    expect(new StoreSchemaError("bad json").name).toBe("StoreSchemaError");
    expect(new WorkflowRunNotFoundError("wf_x").name).toBe("WorkflowRunNotFoundError");
  });
});

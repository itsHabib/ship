/**
 * Smoke test for the public barrel.
 *
 * Asserts the surface enumerated in phases/03-store.md § "API boundaries":
 * `createStore` is callable, the typed error subclasses are exported, and
 * the input types resolve. This catches the case where a per-table refactor
 * silently drops a re-export from `index.ts`.
 *
 * No CRUD coverage here — that's in the per-table test files.
 *
 * Type re-exports are validated by the `import type { ... }` block alone:
 * if any of those names disappear from `index.ts`, this file fails to
 * typecheck (which gates the test run).
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

// Compile-time references to keep the type imports load-bearing — without
// them an autofixer would happily strip "unused" imports and the smoke
// guarantee would silently weaken.
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

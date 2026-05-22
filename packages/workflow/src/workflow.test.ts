/** Tests for `workflow.ts`. Pins schema validation, state machine, and policy defaults. */

import { describe, expect, test } from "vitest";

import type {
  CursorRunRef,
  ModelSelection,
  Phase,
  WorkflowRun,
  WorkflowStatus,
  WorktreeRef,
} from "./workflow.js";

import {
  canTransition,
  cursorRunRefSchema,
  cursorRunRuntimeSchema,
  cursorRunStatusSchema,
  DEFAULT_WORKFLOW_POLICY,
  isTerminal,
  modelSelectionSchema,
  phaseKindSchema,
  phaseSchema,
  phaseStatusSchema,
  terminalCursorRunRefSchema,
  terminalCursorRunStatusSchema,
  terminalWorkflowStatusSchema,
  workflowPolicySchema,
  workflowRunSchema,
  workflowStatusSchema,
  worktreeRefSchema,
} from "./workflow.js";

const validWorktree: WorktreeRef = {
  repo: "ship",
  name: "feat-domain",
  branch: "ship/feat-domain",
  path: "/repo/.worktrees/feat-domain",
  baseRef: "main",
};

const validCursorRunRef: CursorRunRef = {
  id: "cr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  agentId: "agent_abc",
  runtime: "local",
  startedAt: "2026-05-06T12:00:00Z",
  status: "running",
  artifactsDir: "/runs/wf_01ARZ3NDEKTSV4RRFFQ69G5FAV/",
};

const validPhase: Phase = {
  id: "ph_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  workflowRunId: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  kind: "implement",
  status: "pending",
  inputJson: "{}",
};

const validWorkflowRun: WorkflowRun = {
  id: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  repo: "ship",
  docPath: "docs/features/hello.md",
  status: "pending",
  baseRef: "main",
  worktree: validWorktree,
  policy: DEFAULT_WORKFLOW_POLICY,
  createdAt: "2026-05-06T12:00:00Z",
  updatedAt: "2026-05-06T12:00:00Z",
  phases: [],
};

describe("workflowStatusSchema", () => {
  test("accepts each documented value", () => {
    for (const s of ["pending", "running", "succeeded", "failed", "cancelled"] as const) {
      expect(workflowStatusSchema.parse(s)).toBe(s);
    }
  });

  test("rejects values outside the enum", () => {
    expect(workflowStatusSchema.safeParse("done").success).toBe(false);
    expect(workflowStatusSchema.safeParse("").success).toBe(false);
    expect(workflowStatusSchema.safeParse(null).success).toBe(false);
  });
});

describe("phaseStatusSchema", () => {
  test("accepts each documented value", () => {
    for (const s of ["pending", "running", "succeeded", "failed", "cancelled"] as const) {
      expect(phaseStatusSchema.parse(s)).toBe(s);
    }
  });

  test("rejects unknown values", () => {
    expect(phaseStatusSchema.safeParse("blocked").success).toBe(false);
  });
});

describe("phaseKindSchema", () => {
  test("accepts the V1 kind", () => {
    expect(phaseKindSchema.parse("implement")).toBe("implement");
  });

  test("accepts the V2 open_pr kind", () => {
    expect(phaseKindSchema.parse("open_pr")).toBe("open_pr");
  });

  test("rejects unknown kinds", () => {
    expect(phaseKindSchema.safeParse("review").success).toBe(false);
    expect(phaseKindSchema.safeParse("ci_fix").success).toBe(false);
  });
});

describe("cursorRunStatusSchema", () => {
  test("accepts each documented value", () => {
    for (const s of ["running", "succeeded", "failed", "cancelled"] as const) {
      expect(cursorRunStatusSchema.parse(s)).toBe(s);
    }
  });

  test("rejects pending (Cursor runs do not have a pending state)", () => {
    expect(cursorRunStatusSchema.safeParse("pending").success).toBe(false);
  });
});

describe("cursorRunRuntimeSchema", () => {
  test("accepts local runtime", () => {
    expect(cursorRunRuntimeSchema.parse("local")).toBe("local");
  });

  test("accepts cloud runtime (V2 phase 04)", () => {
    expect(cursorRunRuntimeSchema.parse("cloud")).toBe("cloud");
  });

  test("rejects unknown runtime values", () => {
    expect(cursorRunRuntimeSchema.safeParse("remote").success).toBe(false);
    expect(cursorRunRuntimeSchema.safeParse("Cloud").success).toBe(false);
  });
});

describe("terminalWorkflowStatusSchema", () => {
  test("accepts every terminal status", () => {
    for (const s of ["succeeded", "failed", "cancelled"] as const) {
      expect(terminalWorkflowStatusSchema.parse(s)).toBe(s);
    }
  });

  test("rejects non-terminal statuses (the whole point)", () => {
    expect(terminalWorkflowStatusSchema.safeParse("pending").success).toBe(false);
    expect(terminalWorkflowStatusSchema.safeParse("running").success).toBe(false);
  });

  test("rejects values outside the workflow status enum entirely", () => {
    expect(terminalWorkflowStatusSchema.safeParse("done").success).toBe(false);
  });
});

describe("terminalCursorRunStatusSchema", () => {
  test("accepts every terminal cursor-run status", () => {
    for (const s of ["succeeded", "failed", "cancelled"] as const) {
      expect(terminalCursorRunStatusSchema.parse(s)).toBe(s);
    }
  });

  test("rejects running (the only non-terminal cursor-run status)", () => {
    expect(terminalCursorRunStatusSchema.safeParse("running").success).toBe(false);
  });

  test("rejects pending (which isn't a valid cursor-run status at all)", () => {
    expect(terminalCursorRunStatusSchema.safeParse("pending").success).toBe(false);
  });
});

describe("modelSelectionSchema", () => {
  test("accepts an id-only selection", () => {
    const v: ModelSelection = { id: "composer-2" };
    expect(modelSelectionSchema.parse(v)).toEqual(v);
  });

  test("accepts a selection with string params", () => {
    const v: ModelSelection = {
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    };
    expect(modelSelectionSchema.parse(v)).toEqual(v);
  });

  test("accepts boolean param values", () => {
    const v: ModelSelection = {
      id: "composer-2.5",
      params: [{ id: "fast", value: false }],
    };
    expect(modelSelectionSchema.parse(v)).toEqual(v);
  });

  test("rejects unknown keys", () => {
    expect(modelSelectionSchema.safeParse({ id: "x", extra: 1 }).success).toBe(false);
  });

  test("rejects empty id", () => {
    expect(modelSelectionSchema.safeParse({ id: "" }).success).toBe(false);
  });

  test("rejects param entry with empty id or value", () => {
    expect(
      modelSelectionSchema.safeParse({ id: "x", params: [{ id: "", value: "v" }] }).success,
    ).toBe(false);
    expect(
      modelSelectionSchema.safeParse({ id: "x", params: [{ id: "p", value: "" }] }).success,
    ).toBe(false);
  });
});

// Structural-compat with `@cursor/sdk`'s `ModelSelection` is asserted in
// `@ship/cursor-runner` (per phases/05-cursor-runner.md ED-2).

describe("worktreeRefSchema", () => {
  test("accepts a valid worktree", () => {
    expect(worktreeRefSchema.parse(validWorktree)).toEqual(validWorktree);
  });

  test("rejects unknown keys (.strict)", () => {
    expect(worktreeRefSchema.safeParse({ ...validWorktree, extra: 1 }).success).toBe(false);
  });

  test("rejects missing required field", () => {
    const { branch: _branch, ...partial } = validWorktree;
    expect(worktreeRefSchema.safeParse(partial).success).toBe(false);
  });

  test("rejects empty string in required field", () => {
    expect(worktreeRefSchema.safeParse({ ...validWorktree, repo: "" }).success).toBe(false);
  });
});

describe("cursorRunRefSchema", () => {
  test("accepts a minimal valid ref", () => {
    expect(cursorRunRefSchema.parse(validCursorRunRef)).toEqual(validCursorRunRef);
  });

  test("accepts a ref with all optional fields", () => {
    const full: CursorRunRef = {
      ...validCursorRunRef,
      model: { id: "composer-2" },
      endedAt: "2026-05-06T12:30:00Z",
      durationMs: 1800000,
    };
    expect(cursorRunRefSchema.parse(full)).toEqual(full);
  });

  test("rejects unknown keys", () => {
    expect(cursorRunRefSchema.safeParse({ ...validCursorRunRef, extra: "x" }).success).toBe(false);
  });

  test("rejects malformed datetime", () => {
    expect(
      cursorRunRefSchema.safeParse({ ...validCursorRunRef, startedAt: "not-a-date" }).success,
    ).toBe(false);
  });

  test("rejects negative durationMs", () => {
    expect(cursorRunRefSchema.safeParse({ ...validCursorRunRef, durationMs: -1 }).success).toBe(
      false,
    );
  });

  test("accepts durationMs of 0", () => {
    expect(cursorRunRefSchema.safeParse({ ...validCursorRunRef, durationMs: 0 }).success).toBe(
      true,
    );
  });
});

describe("terminalCursorRunRefSchema", () => {
  const terminalRef: CursorRunRef = { ...validCursorRunRef, status: "succeeded" };

  test("accepts a ref with terminal status", () => {
    expect(terminalCursorRunRefSchema.parse(terminalRef)).toEqual(terminalRef);
  });

  test("accepts each terminal status", () => {
    for (const s of ["succeeded", "failed", "cancelled"] as const) {
      expect(
        terminalCursorRunRefSchema.safeParse({ ...validCursorRunRef, status: s }).success,
      ).toBe(true);
    }
  });

  test("rejects a still-running ref", () => {
    expect(
      terminalCursorRunRefSchema.safeParse({ ...validCursorRunRef, status: "running" }).success,
    ).toBe(false);
  });

  test("preserves the parent schema's .strict() (rejects unknown keys)", () => {
    expect(terminalCursorRunRefSchema.safeParse({ ...terminalRef, extra: "x" }).success).toBe(
      false,
    );
  });

  test("preserves the parent schema's other field validations", () => {
    expect(
      terminalCursorRunRefSchema.safeParse({ ...terminalRef, startedAt: "not-a-date" }).success,
    ).toBe(false);
    expect(terminalCursorRunRefSchema.safeParse({ ...terminalRef, durationMs: -1 }).success).toBe(
      false,
    );
  });
});

describe("workflowPolicySchema", () => {
  test("accepts the default policy", () => {
    expect(workflowPolicySchema.parse(DEFAULT_WORKFLOW_POLICY)).toEqual(DEFAULT_WORKFLOW_POLICY);
  });

  test("rejects unknown keys", () => {
    expect(workflowPolicySchema.safeParse({ ...DEFAULT_WORKFLOW_POLICY, extra: 1 }).success).toBe(
      false,
    );
  });

  test("rejects zero duration (positive integer required)", () => {
    expect(
      workflowPolicySchema.safeParse({ ...DEFAULT_WORKFLOW_POLICY, maxRunDurationMs: 0 }).success,
    ).toBe(false);
  });

  test("rejects negative duration", () => {
    expect(
      workflowPolicySchema.safeParse({ ...DEFAULT_WORKFLOW_POLICY, agentTimeoutMs: -1 }).success,
    ).toBe(false);
  });

  test("rejects fractional duration (int required)", () => {
    expect(
      workflowPolicySchema.safeParse({ ...DEFAULT_WORKFLOW_POLICY, maxRunDurationMs: 1.5 }).success,
    ).toBe(false);
  });

  test("rejects empty baseRef", () => {
    expect(
      workflowPolicySchema.safeParse({ ...DEFAULT_WORKFLOW_POLICY, baseRef: "" }).success,
    ).toBe(false);
  });
});

describe("phaseSchema", () => {
  test("accepts a minimal valid phase", () => {
    expect(phaseSchema.parse(validPhase)).toEqual(validPhase);
  });

  test("accepts a phase with all optional fields", () => {
    const full: Phase = {
      ...validPhase,
      startedAt: "2026-05-06T12:00:00Z",
      endedAt: "2026-05-06T12:30:00Z",
      cursorRunId: "cr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      outputJson: '{"ok":true}',
      errorMessage: "boom",
    };
    expect(phaseSchema.parse(full)).toEqual(full);
  });

  test("rejects unknown keys", () => {
    expect(phaseSchema.safeParse({ ...validPhase, extra: 1 }).success).toBe(false);
  });

  test("rejects empty inputJson", () => {
    expect(phaseSchema.safeParse({ ...validPhase, inputJson: "" }).success).toBe(false);
  });

  test("rejects unknown phase kind", () => {
    expect(phaseSchema.safeParse({ ...validPhase, kind: "review" }).success).toBe(false);
  });
});

describe("workflowRunSchema", () => {
  test("accepts a valid run with no phases", () => {
    expect(workflowRunSchema.parse(validWorkflowRun)).toEqual(validWorkflowRun);
  });

  test("accepts a valid run with one phase", () => {
    const run: WorkflowRun = { ...validWorkflowRun, status: "running", phases: [validPhase] };
    expect(workflowRunSchema.parse(run)).toEqual(run);
  });

  test("rejects unknown keys", () => {
    expect(workflowRunSchema.safeParse({ ...validWorkflowRun, extra: 1 }).success).toBe(false);
  });

  test("rejects empty repo", () => {
    expect(workflowRunSchema.safeParse({ ...validWorkflowRun, repo: "" }).success).toBe(false);
  });

  test("rejects malformed nested worktree", () => {
    const bad = { ...validWorkflowRun, worktree: { ...validWorktree, branch: "" } };
    expect(workflowRunSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects malformed nested phase", () => {
    const bad = { ...validWorkflowRun, phases: [{ ...validPhase, kind: "review" }] };
    expect(workflowRunSchema.safeParse(bad).success).toBe(false);
  });
});

describe("DEFAULT_WORKFLOW_POLICY", () => {
  test("matches the spec default", () => {
    expect(DEFAULT_WORKFLOW_POLICY).toEqual({
      baseRef: "main",
      maxRunDurationMs: 30 * 60 * 1000,
      agentTimeoutMs: 30 * 60 * 1000,
    });
  });

  test("validates against workflowPolicySchema", () => {
    expect(workflowPolicySchema.parse(DEFAULT_WORKFLOW_POLICY)).toEqual(DEFAULT_WORKFLOW_POLICY);
  });
});

describe("isTerminal", () => {
  test("returns true for terminal statuses", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  test("returns false for non-terminal statuses", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });
});

describe("canTransition", () => {
  test("permits documented happy-path transitions", () => {
    expect(canTransition("pending", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("running", "cancelled")).toBe(true);
  });

  test("permits cancellation from pending", () => {
    expect(canTransition("pending", "cancelled")).toBe(true);
  });

  test("rejects pending → succeeded (must go through running)", () => {
    expect(canTransition("pending", "succeeded")).toBe(false);
    expect(canTransition("pending", "failed")).toBe(false);
  });

  test("rejects all transitions out of terminal states", () => {
    const terminal: WorkflowStatus[] = ["succeeded", "failed", "cancelled"];
    const targets: WorkflowStatus[] = ["pending", "running", "succeeded", "failed", "cancelled"];
    for (const from of terminal) {
      for (const to of targets) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  test("rejects same-state self-transition (not a meaningful transition)", () => {
    expect(canTransition("pending", "pending")).toBe(false);
    expect(canTransition("running", "running")).toBe(false);
  });

  test("rejects running → pending (no rewind)", () => {
    expect(canTransition("running", "pending")).toBe(false);
  });
});

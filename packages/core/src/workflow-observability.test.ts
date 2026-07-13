/** Unit tests for the store-backed workflow observability projector. */

import type { CursorRunRef, WorkflowPolicy, WorktreeRef } from "@ship/workflow";

import { workflowObservabilityViewSchema } from "@ship/mcp";
import { DEFAULT_WORKFLOW_POLICY } from "@ship/workflow";
import { describe, expect, test } from "vitest";

import {
  collectAbsolutePathStrings,
  collectForbiddenObservabilityKeys,
  projectWorkflowObservability,
  sanitizeFailureDetail,
} from "./workflow-observability.js";

const validWorktree: WorktreeRef = {
  baseRef: "main",
  branch: "ship/feat",
  name: "feat",
  path: "/repo/.worktrees/feat",
  repo: "ship",
};

const validPolicy: WorkflowPolicy = DEFAULT_WORKFLOW_POLICY;

const baseCursorRun: CursorRunRef = {
  agentId: "agent_abc",
  artifactsDir: "/home/user/.config/ship/runs/wf_x",
  id: "cr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  provider: "cursor",
  runtime: "local",
  startedAt: "2026-05-06T12:00:00.000Z",
  status: "succeeded",
};

describe("projectWorkflowObservability — local", () => {
  test("actual runtime/provider/model come from cursor run; requested runtime stays absent", () => {
    const run = {
      id: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repo: "ship",
      docPath: "docs/x.md",
      status: "succeeded" as const,
      baseRef: "main",
      worktree: validWorktree,
      policy: validPolicy,
      createdAt: "2026-05-06T12:00:00.000Z",
      updatedAt: "2026-05-06T12:30:00.000Z",
      phases: [
        {
          id: "ph_1",
          workflowRunId: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          kind: "implement" as const,
          status: "succeeded" as const,
          inputJson: JSON.stringify({ docPath: "docs/x.md" }),
          startedAt: "2026-05-06T12:00:00.000Z",
          endedAt: "2026-05-06T12:30:00.000Z",
          cursorRunId: baseCursorRun.id,
        },
      ],
    };
    const cursorRun: CursorRunRef = {
      ...baseCursorRun,
      endedAt: "2026-05-06T12:30:00.000Z",
      durationMs: 1_800_000,
      model: { id: "composer-2" },
    };
    const view = projectWorkflowObservability(run, cursorRun);
    expect(view.requested).toBeUndefined();
    expect(view.actual).toEqual({
      runtime: "local",
      provider: "cursor",
      model: { id: "composer-2" },
    });
    expect(view.durationMs).toBe(1_800_000);
    expect(view.evidence).toEqual({
      availability: "unavailable",
      reason: "no-persisted-artifact-manifest",
    });
    workflowObservabilityViewSchema.parse(view);
  });

  test("omits durationMs when producer facts do not establish it", () => {
    const run = {
      id: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repo: "ship",
      docPath: "docs/x.md",
      status: "running" as const,
      baseRef: "main",
      worktree: validWorktree,
      policy: validPolicy,
      createdAt: "2026-05-06T12:00:00.000Z",
      updatedAt: "2026-05-06T12:00:01.000Z",
      phases: [
        {
          id: "ph_1",
          workflowRunId: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          kind: "implement" as const,
          status: "running" as const,
          inputJson: JSON.stringify({ docPath: "docs/x.md" }),
          startedAt: "2026-05-06T12:00:00.000Z",
          cursorRunId: baseCursorRun.id,
        },
      ],
    };
    const view = projectWorkflowObservability(run, baseCursorRun);
    expect(view.durationMs).toBeUndefined();
    expect(view.endedAt).toBeUndefined();
  });
});

describe("projectWorkflowObservability — cloud", () => {
  test("requested runtime cloud from persisted input_json; actual from cursor row", () => {
    const run = {
      id: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repo: "ship",
      docPath: "docs/x.md",
      status: "succeeded" as const,
      baseRef: "main",
      worktree: { ...validWorktree, path: "(cloud)", name: "(cloud)" },
      policy: validPolicy,
      createdAt: "2026-05-06T12:00:00.000Z",
      updatedAt: "2026-05-06T12:30:00.000Z",
      phases: [
        {
          id: "ph_1",
          workflowRunId: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          kind: "implement" as const,
          status: "succeeded" as const,
          inputJson: JSON.stringify({
            cloud: { repos: [{ url: "https://github.com/o/r" }] },
            docPath: "docs/x.md",
          }),
          cursorRunId: baseCursorRun.id,
        },
      ],
    };
    const cursorRun: CursorRunRef = {
      ...baseCursorRun,
      runtime: "cloud",
      endedAt: "2026-05-06T12:30:00.000Z",
      durationMs: 42_000,
      artifacts: [
        {
          path: "artifacts/prompt.md",
          sizeBytes: 128,
          updatedAt: "2026-05-06T12:30:00.000Z",
        },
      ],
    };
    const view = projectWorkflowObservability(run, cursorRun);
    expect(view.requested).toEqual({ runtime: "cloud" });
    expect(view.actual?.runtime).toBe("cloud");
    expect(view.evidence).toEqual({
      availability: "available",
      refs: [
        {
          path: "artifacts/prompt.md",
          sizeBytes: 128,
          updatedAt: "2026-05-06T12:30:00.000Z",
        },
      ],
    });
  });
});

describe("projectWorkflowObservability — rooms", () => {
  test("requested runtime rooms from persisted input_json", () => {
    const run = {
      id: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repo: "ship",
      docPath: "docs/x.md",
      status: "succeeded" as const,
      baseRef: "main",
      worktree: { ...validWorktree, path: "(cloud)", name: "(cloud)" },
      policy: validPolicy,
      createdAt: "2026-05-06T12:00:00.000Z",
      updatedAt: "2026-05-06T12:30:00.000Z",
      phases: [
        {
          id: "ph_1",
          workflowRunId: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          kind: "implement" as const,
          status: "succeeded" as const,
          inputJson: JSON.stringify({
            room: { repos: [{ url: "https://github.com/o/r" }] },
            docPath: "docs/x.md",
          }),
          cursorRunId: baseCursorRun.id,
        },
      ],
    };
    const cursorRun: CursorRunRef = { ...baseCursorRun, runtime: "rooms" };
    const view = projectWorkflowObservability(run, cursorRun);
    expect(view.requested).toEqual({ runtime: "rooms" });
    expect(view.actual?.runtime).toBe("rooms");
  });
});

describe("projectWorkflowObservability — failure", () => {
  test("surfaces failure category and sanitized detail without absolute paths", () => {
    const run = {
      id: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repo: "ship",
      docPath: "docs/x.md",
      status: "failed" as const,
      baseRef: "main",
      worktree: validWorktree,
      policy: validPolicy,
      createdAt: "2026-05-06T12:00:00.000Z",
      updatedAt: "2026-05-06T12:30:00.000Z",
      phases: [
        {
          id: "ph_1",
          workflowRunId: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          kind: "implement" as const,
          status: "failed" as const,
          inputJson: JSON.stringify({ docPath: "docs/x.md" }),
          errorMessage: "failed at /home/user/secret GITHUB_TOKEN=ghp_deadbeef",
          failureCategory: "sdk-throw" as const,
        },
      ],
    };
    const view = projectWorkflowObservability(run, null);
    expect(view.failure).toEqual({
      category: "sdk-throw",
      detail: "failed at [path]",
    });
    expect(collectAbsolutePathStrings(view)).toEqual([]);
    expect(collectForbiddenObservabilityKeys(view)).toEqual([]);
  });
});

describe("sanitizeFailureDetail", () => {
  test("redacts quoted and unquoted absolute paths and token-like secrets", () => {
    expect(sanitizeFailureDetail('open "/etc/passwd" failed')).toBe("open [path] failed");
    expect(sanitizeFailureDetail("token ghp_abc123xyz leaked")).toBe("token [token] leaked");
    expect(sanitizeFailureDetail("Bearer sk-live-abc")).toBe("Bearer [token]");
  });

  test("redacts absolute paths on every line of a multiline message", () => {
    const msg = "Error reading /etc/secret on line 1\nAlso failed at /home/user/data on line 2";
    const result = sanitizeFailureDetail(msg);
    expect(result).not.toContain("/etc/secret");
    expect(result).not.toContain("/home/user/data");
    expect(result).toBe("Error reading [path]\nAlso failed at [path]");
  });
});

describe("projectWorkflowObservability — redaction", () => {
  test("never exposes artifactsDir or absolute artifact paths in evidence refs", () => {
    const run = {
      id: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repo: "ship",
      docPath: "docs/x.md",
      status: "succeeded" as const,
      baseRef: "main",
      worktree: validWorktree,
      policy: validPolicy,
      createdAt: "2026-05-06T12:00:00.000Z",
      updatedAt: "2026-05-06T12:30:00.000Z",
      phases: [],
    };
    const cursorRun: CursorRunRef = {
      ...baseCursorRun,
      artifactsDir: "/abs/runs/wf_x",
      artifacts: [
        {
          path: "/abs/runs/wf_x/prompt.md",
          sizeBytes: 10,
          updatedAt: "2026-05-06T12:30:00.000Z",
        },
        {
          path: "relative/prompt.md",
          sizeBytes: 10,
          updatedAt: "2026-05-06T12:30:00.000Z",
        },
      ],
    };
    const view = projectWorkflowObservability(run, cursorRun);
    expect(view.evidence?.refs).toEqual([
      {
        path: "relative/prompt.md",
        sizeBytes: 10,
        updatedAt: "2026-05-06T12:30:00.000Z",
      },
    ]);
    expect(collectForbiddenObservabilityKeys(view)).toEqual([]);
    expect(collectAbsolutePathStrings(view)).toEqual([]);
  });
});

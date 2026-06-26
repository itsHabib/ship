// Cursor-bound failure classification — core imports these so it stays
// projection-free. Policy lives in `@ship/agent-runner`.

import type { AgentEvent, BuildFailureDetailInput, ClassifyFailureInput } from "@ship/agent-runner";

import {
  buildFailureDetail as buildFailureDetailBase,
  classifyFailure as classifyFailureBase,
  formatClassifiedErrorMessage,
} from "@ship/agent-runner";

import { cursorEventProjection } from "./cursor-event-projection.js";

export { formatClassifiedErrorMessage };

export type CursorClassifyFailureInput = Omit<ClassifyFailureInput, "projection">;

export type CursorBuildFailureDetailInput = Omit<BuildFailureDetailInput, "projection">;

export function classifyFailure(input: CursorClassifyFailureInput) {
  return classifyFailureBase({
    ...input,
    projection: cursorEventProjection,
  });
}

export function buildFailureDetail(input: CursorBuildFailureDetailInput) {
  return buildFailureDetailBase({
    ...input,
    projection: cursorEventProjection,
  });
}

export type { AgentEvent };

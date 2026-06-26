/** Barrel export smoke tests. */

import { describe, expect, test } from "vitest";

import * as barrel from "./index.js";

describe("@ship/claude-runner barrel", () => {
  test("exports LocalClaudeRunner and classifier entrypoints", () => {
    expect(barrel.LocalClaudeRunner).toBeTypeOf("function");
    expect(barrel.classifyFailure).toBeTypeOf("function");
    expect(barrel.buildFailureDetail).toBeTypeOf("function");
    expect(barrel.claudeEventProjection).toBeTypeOf("object");
  });
});

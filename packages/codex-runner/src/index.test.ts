/** Barrel export smoke tests. */

import { describe, expect, test } from "vitest";

import * as barrel from "./index.js";

describe("@ship/codex-runner barrel", () => {
  test("exports CodexRunner and classifier entrypoints", () => {
    expect(barrel.CodexRunner).toBeTypeOf("function");
    expect(barrel.classifyFailure).toBeTypeOf("function");
    expect(barrel.buildFailureDetail).toBeTypeOf("function");
    expect(barrel.codexEventProjection).toBeTypeOf("object");
  });
});

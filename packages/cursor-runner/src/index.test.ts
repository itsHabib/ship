/**
 * Smoke test for the main public barrel. Only runtime exports are
 * asserted here — type re-exports are erased at runtime and caught at
 * typecheck time by every consumer that imports them.
 */

import { describe, expect, test } from "vitest";

import * as cursorRunner from "./index.js";

describe("@ship/cursor-runner barrel export (index.ts)", () => {
  test("re-exports the typed error classes", () => {
    expect(typeof cursorRunner.MissingApiKeyError).toBe("function");
    expect(typeof cursorRunner.AgentRunFailedError).toBe("function");
    expect(new cursorRunner.MissingApiKeyError()).toBeInstanceOf(Error);
  });

  test("re-exports LocalCursorRunner (the V1 runtime implementation)", () => {
    expect(typeof cursorRunner.LocalCursorRunner).toBe("function");
    expect(new cursorRunner.LocalCursorRunner()).toBeInstanceOf(cursorRunner.LocalCursorRunner);
  });

  test("re-exports CloudCursorRunner (cloud runtime skeleton)", () => {
    expect(typeof cursorRunner.CloudCursorRunner).toBe("function");
    expect(new cursorRunner.CloudCursorRunner()).toBeInstanceOf(cursorRunner.CloudCursorRunner);
  });

  test("does NOT re-export FakeCursorRunner from the main barrel", () => {
    // The fake is only reachable via the `./test/fake` subpath so
    // consumer production code can't import it accidentally.
    expect("FakeCursorRunner" in cursorRunner).toBe(false);
  });
});

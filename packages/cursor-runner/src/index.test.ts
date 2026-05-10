/**
 * Smoke test for `index.ts` (the package's main public barrel).
 *
 * Only runtime exports are asserted here: `MissingApiKeyError` and
 * `CursorRunFailedError`. The `runner.ts` types and the SDK
 * re-exports (`SDKMessage`, `McpServerConfig`) are erased at runtime
 * (`export type ...`), so a smoke test can't reach them — drift in
 * those is caught at typecheck time by every consumer that imports
 * them. A typo in a runtime export would otherwise only surface in a
 * downstream package's CI; this test fails it loud here.
 *
 * `FakeCursorRunner` lives behind the `./test/fake` subpath, NOT the
 * main barrel — its absence here is intentional, not an oversight.
 */

import { describe, expect, test } from "vitest";

import * as cursorRunner from "./index.js";

describe("@ship/cursor-runner barrel export (index.ts)", () => {
  test("re-exports the typed error classes", () => {
    expect(typeof cursorRunner.MissingApiKeyError).toBe("function");
    expect(typeof cursorRunner.CursorRunFailedError).toBe("function");
    expect(new cursorRunner.MissingApiKeyError()).toBeInstanceOf(Error);
  });

  test("does NOT re-export FakeCursorRunner from the main barrel", () => {
    // The fake is intentionally only reachable via the `./test/fake`
    // subpath (per `package.json#exports`) so consumer production code
    // can't import it accidentally.
    expect("FakeCursorRunner" in cursorRunner).toBe(false);
  });
});

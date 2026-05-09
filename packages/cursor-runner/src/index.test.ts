/**
 * Smoke test for `index.ts` (the package's main public barrel).
 *
 * `runner.ts` is type-only; its exports don't appear at runtime. This
 * file verifies the runtime exports the barrel makes consumers depend
 * on — error classes and the SDK type re-exports — exist and are the
 * right shape. A typo in the barrel would otherwise only surface in a
 * downstream package.
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

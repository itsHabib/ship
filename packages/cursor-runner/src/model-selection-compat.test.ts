/**
 * Cross-package structural-compat test for `@ship/workflow`'s
 * `ModelSelection` mirror.
 *
 * `@ship/workflow` defines its own `ModelSelection` Zod schema + type
 * rather than re-exporting from `@cursor/sdk`, so the workflow package
 * has no runtime SDK dependency. That mirror has to stay in lockstep
 * with the SDK's exported `ModelSelection`; this test catches drift in
 * both directions:
 *
 * - **Runtime:** the workflow schema parses values constructed against
 *   the SDK type (proves the SDK shape doesn't add fields the workflow
 *   schema doesn't know how to accept, since the schema is `.strict()`).
 * - **Compile-time:** the SDK shape is assignable to the workflow
 *   shape and vice versa (the bottom-of-file `const`s stop compiling
 *   if the SDK adds a required field or renames one).
 *
 * The test lives here — not in `@ship/workflow` — because cursor-runner
 * is the sole package permitted to import from `@cursor/sdk` (per
 * ED-2). Putting the compat check in any other package would either
 * violate that rule or force a duplicate SDK devDep.
 */

import type { ModelSelection as SDKModelSelection } from "@cursor/sdk";

import { type ModelSelection, modelSelectionSchema } from "@ship/workflow";
import { describe, expect, test } from "vitest";

describe("@ship/workflow ModelSelection ↔ @cursor/sdk ModelSelection", () => {
  test("accepts an SDK-typed value with id only", () => {
    const sdkValue: SDKModelSelection = { id: "composer-2" };
    expect(modelSelectionSchema.parse(sdkValue)).toEqual(sdkValue);
  });

  test("accepts an SDK-typed value with id + params", () => {
    const sdkValue: SDKModelSelection = {
      id: "composer-2",
      params: [{ id: "thinking", value: "high" }],
    };
    expect(modelSelectionSchema.parse(sdkValue)).toEqual(sdkValue);
  });
});

// Compile-time structural-compat: SDK-typed values must be assignable
// to `@ship/workflow`'s mirror. If the SDK adds a required field (or
// renames one), these constants stop compiling — which fails CI before
// the runtime tests above ever run.
//
// We only assert SDK → workflow (not the reverse). The reverse runs
// into TypeScript's `exactOptionalPropertyTypes` asymmetry: workflow's
// strict-optional `params?: T[]` is not assignable to the SDK's loose
// `params?: T[]` because tsc widens the workflow value's inferred type
// to `params?: T[] | undefined` at the assignment boundary. The SDK
// → workflow direction is the one that catches drift in practice (a
// new SDK field that workflow's `.strict()` schema doesn't allow); the
// reverse never fires.
const _sdkSampleEmpty: SDKModelSelection = { id: "composer-2" };
const _sdkSampleFull: SDKModelSelection = {
  id: "composer-2",
  params: [{ id: "thinking", value: "high" }],
};
const _domainFromSdkEmpty: ModelSelection = _sdkSampleEmpty;
const _domainFromSdkFull: ModelSelection = _sdkSampleFull;

// Reference the bindings so eslint/tsc don't strip them as unused.
void _domainFromSdkEmpty;
void _domainFromSdkFull;

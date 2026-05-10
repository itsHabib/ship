/**
 * Cross-package structural-compat: `@ship/workflow`'s `ModelSelection`
 * mirror parses values typed against `@cursor/sdk`'s `ModelSelection`.
 * Lives here because cursor-runner is the only package permitted to
 * import from `@cursor/sdk` (ED-2).
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

// Compile-time SDK → workflow assignability. If the SDK adds a
// required field (or renames one), these stop compiling. The reverse
// direction is omitted: workflow's strict-optional `params?: T[]`
// can't widen to the SDK's loose-optional `params?: T[] | undefined`
// under `exactOptionalPropertyTypes`.
const _sdkSampleEmpty: SDKModelSelection = { id: "composer-2" };
const _sdkSampleFull: SDKModelSelection = {
  id: "composer-2",
  params: [{ id: "thinking", value: "high" }],
};
const _domainFromSdkEmpty: ModelSelection = _sdkSampleEmpty;
const _domainFromSdkFull: ModelSelection = _sdkSampleFull;

void _domainFromSdkEmpty;
void _domainFromSdkFull;

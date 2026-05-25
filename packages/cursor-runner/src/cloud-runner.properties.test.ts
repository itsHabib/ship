/**
 * Property-based checks for cloud-runner model arg coercion.
 */

import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import type { CursorRunInput } from "./runner.js";

import { modelArgFromInput } from "./cloud-runner.js";

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ITER = readPositiveIntEnv("SHIP_PROP_ITER", 100);
const PROP_SEED = readPositiveIntEnv("SHIP_PROP_SEED", 0x2fed12f);

fc.configureGlobal({ seed: PROP_SEED });

const modelParamArbitrary = fc.record({
  id: fc.string({ minLength: 1 }),
  value: fc.oneof(fc.string({ minLength: 1 }), fc.boolean()),
});

function expectCoercedParam(
  param: { id: string; value: string | boolean },
  out: { id: string; value: string } | undefined,
): void {
  expect(out?.id).toBe(param.id);
  expect(typeof out?.value).toBe("string");
  const expected = typeof param.value === "boolean" ? String(param.value) : param.value;
  expect(out?.value).toBe(expected);
}

function expectStringCoercedParams(
  params: readonly { id: string; value: string | boolean }[],
  sdkModel: ReturnType<typeof modelArgFromInput>,
): void {
  if (params.length === 0) {
    expect(sdkModel.params === undefined || sdkModel.params.length === 0).toBe(true);
    return;
  }
  expect(sdkModel.params).toHaveLength(params.length);
  for (let i = 0; i < params.length; i += 1) {
    const param = params[i];
    if (param === undefined) continue;
    expectCoercedParam(param, sdkModel.params?.[i]);
  }
}

describe("cloud-runner properties (fast-check)", () => {
  test.prop([fc.array(modelParamArbitrary, { maxLength: 8 })], { numRuns: ITER })(
    "CL1: modelArgFromInput coerces every param value to string",
    (params) => {
      const input: CursorRunInput = {
        cwd: "/tmp",
        model: { id: "composer-2.5", params },
        onEvent: () => undefined,
        prompt: "test",
        runtime: "cloud",
      };

      const sdkModel = modelArgFromInput(input);
      expect(sdkModel.id).toBe("composer-2.5");
      expectStringCoercedParams(params, sdkModel);
    },
  );
});

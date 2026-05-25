/**
 * Property-based Zod schema round-trip checks for MCP wire contracts.
 */

import { fc, test } from "@fast-check/vitest";
import { cursorRunRuntimeSchema } from "@ship/workflow";
import { describe, expect } from "vitest";

import type { ShipInput } from "./mcp.js";

import { cloudRunSpecSchema, shipInputSchema } from "./mcp.js";

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ITER = readPositiveIntEnv("SHIP_PROP_ITER", 100);
const PROP_SEED = readPositiveIntEnv("SHIP_PROP_SEED", 0x2fed12f);

fc.configureGlobal({ seed: PROP_SEED });

const cloudEnvArbitrary = fc.record({
  type: fc.constantFrom("cloud", "pool", "machine" as const),
  name: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
});

const cloudRunSpecArbitrary = fc.record({
  repos: fc.tuple(
    fc.record({
      url: fc.webUrl(),
      startingRef: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
      prUrl: fc.option(fc.webUrl(), { nil: undefined }),
    }),
  ),
  workOnCurrentBranch: fc.option(fc.boolean(), { nil: undefined }),
  autoCreatePR: fc.option(fc.boolean(), { nil: undefined }),
  skipReviewerRequest: fc.option(fc.boolean(), { nil: undefined }),
  envVars: fc.option(fc.dictionary(fc.string({ minLength: 1 }), fc.string()), {
    nil: undefined,
  }),
  env: fc.option(cloudEnvArbitrary, { nil: undefined }),
});

const localShipInputArbitrary: fc.Arbitrary<ShipInput> = fc.record({
  workdir: fc.string({ minLength: 1 }),
  repo: fc.string({ minLength: 1 }),
  docPath: fc.string({ minLength: 1 }),
  worktreeName: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  branch: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  baseRef: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  model: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  modelParams: fc.option(
    fc.array(
      fc.record({
        id: fc.string({ minLength: 1 }),
        value: fc.oneof(fc.string({ minLength: 1 }), fc.boolean()),
      }),
      { maxLength: 4 },
    ),
    { nil: undefined },
  ),
});

describe("MCP schema properties (fast-check)", () => {
  test.prop([localShipInputArbitrary], { numRuns: ITER })(
    "M1: ShipInput round-trips through JSON.parse → shipInputSchema.parse",
    (input) => {
      const once = shipInputSchema.parse(input);
      const raw: unknown = JSON.parse(JSON.stringify(once));
      const twice = shipInputSchema.parse(raw);
      expect(twice).toEqual(once);
    },
  );

  test.prop([cloudRunSpecArbitrary], { numRuns: ITER })(
    "M2: CloudRunSpec round-trip preserves env discriminator",
    (spec) => {
      const once = cloudRunSpecSchema.parse(spec);
      const raw: unknown = JSON.parse(JSON.stringify(once));
      const twice = cloudRunSpecSchema.parse(raw);
      expect(twice).toEqual(once);
      if (once.env !== undefined) {
        expect(twice.env?.type).toBe(once.env.type);
      }
    },
  );

  test.prop([fc.constantFrom("local", "cloud"), fc.string()], { numRuns: ITER })(
    "M3: cursorRunRuntimeSchema accepts local/cloud and rejects other strings",
    (valid, other) => {
      expect(cursorRunRuntimeSchema.parse(valid)).toBe(valid);
      if (other !== "local" && other !== "cloud") {
        expect(cursorRunRuntimeSchema.safeParse(other).success).toBe(false);
      }
    },
  );
});

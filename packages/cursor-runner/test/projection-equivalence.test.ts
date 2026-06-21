/**
 * Projection-equivalence gate: classifier output must match the frozen
 * baseline derived from pre-refactor `classify-failure.test.ts` cases.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { buildFailureDetail, classifyFailure } from "../src/classify-failure.js";

interface BaselineCase {
  readonly name: string;
  readonly classifyInput: Parameters<typeof classifyFailure>[0];
  readonly category: string;
  readonly detailInput?: Parameters<typeof buildFailureDetail>[0];
  readonly detail?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  readFileSync(join(HERE, "classify-failure-baseline.json"), "utf-8"),
) as readonly BaselineCase[];

describe("projection-equivalence baseline", () => {
  test.each(baseline.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(classifyFailure(c.classifyInput)).toBe(c.category);
    if (c.detailInput !== undefined && c.detail !== undefined) {
      expect(buildFailureDetail(c.detailInput)).toBe(c.detail);
    }
  });
});

/** Smoke test for the `@ship/core` barrel. Asserts runtime exports exist. */

import { describe, expect, test } from "vitest";

import * as core from "./index.js";

describe("@ship/core barrel export (index.ts)", () => {
  test("re-exports the fs factories", () => {
    expect(typeof core.createNodeShipFs).toBe("function");
    expect(typeof core.createMemoryShipFs).toBe("function");
  });

  test("re-exports the artifact helpers", () => {
    expect(typeof core.createNdjsonEventWriter).toBe("function");
    expect(typeof core.resolveRunArtifactsDir).toBe("function");
    expect(typeof core.resolveRunArtifactPaths).toBe("function");
    expect(typeof core.renderImplementationPrompt).toBe("function");
    expect(core.ARTIFACT_FILES.events).toBe("events.ndjson");
  });

  test("re-exports the default production-wiring factory", () => {
    expect(typeof core.createDefaultShipService).toBe("function");
  });
});

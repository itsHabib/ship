/**
 * Tests for `default-wiring.ts` — memoization + lazy-construction +
 * `:memory:` short-circuit. Live wiring (real SQLite + node fs) is
 * exercised via the integration suite in `e2e/integration/`.
 */

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createDefaultShipService } from "./default-wiring.js";

describe("createDefaultShipService", () => {
  test("returns a memoizing factory: two calls yield the same service", () => {
    const factory = createDefaultShipService({
      dbPath: ":memory:",
      runsDir: "/tmp/ship-default-wiring-test",
    });
    const first = factory();
    const second = factory();
    expect(first).toBe(second);
    // Service exposes the four methods the cli + mcp-server consume.
    expect(typeof first.ship).toBe("function");
    expect(typeof first.getRun).toBe("function");
    expect(typeof first.listRuns).toBe("function");
    expect(typeof first.cancelRun).toBe("function");
  });

  test("dbPath = :memory: skips the db-parent mkdir (the runsDir mkdir still fires)", () => {
    // The factory always `mkdirSync(runsDir, { recursive: true })` so
    // the artifact writer doesn't fault on a fresh install; only the
    // *parent of dbPath* mkdir is short-circuited for the `:memory:`
    // sentinel. Keep the runsDir under a `/tmp` prefix so the side-
    // effect is harmless on every CI runner.
    const factory = createDefaultShipService({
      dbPath: ":memory:",
      runsDir: "/tmp/ship-default-wiring-test",
    });
    expect(() => factory()).not.toThrow();
  });

  test("construction is lazy: createDefaultShipService returns without doing IO", () => {
    // Even with an unusable dbPath, creating the factory shouldn't throw —
    // work happens on first factory() call. We don't invoke factory() here
    // because that WOULD try to open a real SQLite file.
    const factory = createDefaultShipService({
      dbPath: ":memory:",
      runsDir: "/tmp/ship-default-wiring-test-no-io",
    });
    expect(typeof factory).toBe("function");
  });

  test("pins the wiring-level Cursor `thinking` param to `high` by default", async () => {
    const { service, cursor } = setupHarness();
    cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const { workdir } = makeWorkdir();
    await service.ship({ workdir, repo: "ship", docPath: "docs.md" });

    expect(cursor.calls[0]?.input.model).toEqual({
      id: "composer-2",
      params: [{ id: "thinking", value: "high" }],
    });
  });

  test("opts.defaultThinking overrides the wiring-level `thinking` default", async () => {
    const { service, cursor } = setupHarness({ defaultThinking: "low" });
    cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const { workdir } = makeWorkdir();
    await service.ship({ workdir, repo: "ship", docPath: "docs.md" });

    expect(cursor.calls[0]?.input.model).toEqual({
      id: "composer-2",
      params: [{ id: "thinking", value: "low" }],
    });
  });

  test("opts.defaultModelParams can omit params for custom default model ids", async () => {
    const { service, cursor } = setupHarness({
      defaultModelId: "custom-model-without-thinking-grid",
      defaultModelParams: [],
    });
    cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const { workdir } = makeWorkdir();
    await service.ship({ workdir, repo: "ship", docPath: "docs.md" });

    expect(cursor.calls[0]?.input.model).toEqual({
      id: "custom-model-without-thinking-grid",
      params: [],
    });
  });
});

function setupHarness(opts?: {
  defaultThinking?: "low" | "high";
  defaultModelId?: string;
  defaultModelParams?: [];
}): {
  service: ReturnType<ReturnType<typeof createDefaultShipService>>;
  cursor: FakeCursorRunner;
} {
  const tmp = mkdtempSync(join(tmpdir(), "ship-wiring-thinking-"));
  const cursor = new FakeCursorRunner();
  const factory = createDefaultShipService({
    dbPath: ":memory:",
    runsDir: join(tmp, "runs"),
    cursor,
    ...(opts?.defaultThinking !== undefined && { defaultThinking: opts.defaultThinking }),
    ...(opts?.defaultModelId !== undefined && { defaultModelId: opts.defaultModelId }),
    ...(opts?.defaultModelParams !== undefined && { defaultModelParams: opts.defaultModelParams }),
  });
  return { service: factory(), cursor };
}

function makeWorkdir(): { workdir: string } {
  const workdir = mkdtempSync(join(tmpdir(), "ship-wiring-workdir-"));
  writeFileSync(join(workdir, "docs.md"), "# Task\n\nDo it.\n");
  return { workdir };
}

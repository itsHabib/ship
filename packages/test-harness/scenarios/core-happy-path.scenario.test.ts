/**
 * Cross-package scenario: full `ShipService` happy-path lifecycle.
 * Drives `ship()` → `getRun()` → `listRuns()` against the harness's
 * `FakeCursorRunner` + in-memory `ShipFs`, asserts the hydrated row
 * AND every artifact file ends up where the API contract promises.
 */

import { afterEach, beforeEach, expect, test } from "vitest";

import type { Harness, ServiceBundle } from "../src/index.js";

import { createHarness, createServiceFromHarness } from "../src/index.js";

const WORKDIR = "/work/wt/feat";

let h: Harness;
let svc: ServiceBundle;

beforeEach(async () => {
  h = createHarness();
  svc = createServiceFromHarness(h);
  await svc.fs.mkdir(WORKDIR, { recursive: true });
  await svc.fs.writeFile(`${WORKDIR}/docs.md`, "# Task\n\nImplement the thing.\n");
});

afterEach(() => {
  h.close();
});

test("happy path: ship → succeeded; row hydrates; artifacts persisted", async () => {
  h.cursor.enqueue({
    events: [],
    result: {
      status: "succeeded",
      durationMs: 12_345,
      summary: "shipped the thing",
      branches: [],
    },
  });

  const out = await svc.service.ship({
    workdir: WORKDIR,
    repo: "ship",
    docPath: "docs.md",
  });

  expect(out.status).toBe("succeeded");
  expect(out.summary).toBe("shipped the thing");
  expect(out.cursorRun.status).toBe("succeeded");

  const got = await svc.service.getRun(out.workflowRunId);
  expect(got?.status).toBe("succeeded");
  expect(got?.phases).toHaveLength(1);
  expect(got?.phases[0]?.cursorRunId).toBe(out.cursorRun.id);

  const list = await svc.service.listRuns({ limit: 10 });
  expect(list.map((r) => r.id)).toContain(out.workflowRunId);

  const taskDocPath = out.artifacts.eventsPath.replace("events.ndjson", "task-doc.md");
  const taskDoc = await svc.fs.readFile(taskDocPath, "utf-8");
  expect(taskDoc).toBe("# Task\n\nImplement the thing.\n");

  const prompt = await svc.fs.readFile(out.artifacts.promptPath, "utf-8");
  expect(prompt).toContain("Repo: ship");
  expect(prompt).toContain("Implement the thing.");

  const result = await svc.fs.readFile(out.artifacts.resultPath, "utf-8");
  expect(JSON.parse(result)).toMatchObject({ status: "succeeded", summary: "shipped the thing" });
});

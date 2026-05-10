/**
 * Cross-package scenario: cancel-mid-flight through `ShipService`.
 * Schedules a long-delay run, fires `cancelRun()` while events are
 * streaming, and asserts the workflow row + cursor-run + ShipOutput
 * all reach a terminal `cancelled` state — and that whatever events
 * managed to stream survive in `events.ndjson`.
 */

import { afterEach, beforeEach, expect, test } from "vitest";

import type { Harness, ServiceBundle } from "../src/index.js";

import { createHarness, createServiceFromHarness } from "../src/index.js";

const WORKDIR = "/work/wt/cancel";

let h: Harness;
let svc: ServiceBundle;

beforeEach(async () => {
  h = createHarness();
  svc = createServiceFromHarness(h);
  await svc.fs.mkdir(WORKDIR, { recursive: true });
  await svc.fs.writeFile(`${WORKDIR}/docs.md`, "# Cancel me");
});

afterEach(() => {
  h.close();
});

test("cancel mid-flight: workflow + cursor-run terminal cancelled; partial events survive", async () => {
  const evt = {
    type: "assistant" as const,
    agent_id: "agent-1",
    run_id: "run-1",
    message: { role: "assistant" as const, content: [{ type: "text", text: "step" }] },
  };
  h.cursor.enqueue({
    events: [evt, evt, evt, evt, evt] as never,
    result: { status: "succeeded", durationMs: 0, branches: [] },
    cancelBehavior: "complete",
    delayMsBetweenEvents: 50,
  });

  const shipPromise = svc.service.ship({
    workdir: WORKDIR,
    repo: "ship",
    docPath: "docs.md",
  });

  // Let a couple of events stream before cancelling.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 80);
  });

  const runs = await svc.service.listRuns({ limit: 10 });
  const id = runs[0]?.id;
  expect(id).toBeDefined();
  if (id === undefined) return;

  const cancelOut = await svc.service.cancelRun(id);
  expect(cancelOut.status).toBe("cancelled");

  const out = await shipPromise;
  expect(out.status).toBe("cancelled");
  expect(out.cursorRun.status).toBe("cancelled");

  const row = await svc.service.getRun(out.workflowRunId);
  expect(row?.status).toBe("cancelled");

  const events = await svc.fs.readFile(out.artifacts.eventsPath, "utf-8");
  const lines = events.split("\n").filter((l) => l.length > 0);
  expect(lines.length).toBeGreaterThan(0);
});

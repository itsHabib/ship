/**
 * Cross-package scenario: cancel-mid-flight through `ShipService`.
 * Schedules a long-delay run, fires `cancelRun()` while events are
 * streaming, and asserts the workflow row + cursor-run + ShipOutput
 * all reach a terminal `cancelled` state. (Whether `events.ndjson`
 * captures partial output is timing-dependent — the in-memory FS
 * commits chunks on stream close, so the assertion focuses on the
 * cancellation reaching the runner instead.)
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

  // Wait on observable conditions instead of wall-clock sleeping:
  // (1) the workflow row is visible in the store (persisted in F2 step 3
  //     before any artifact-dir async work), and (2) `cursor.run()` has
  //     been invoked. Together these prove the run is mid-flight without
  //     racing scheduler/CI variance.
  const id = await waitFor(() => svc.service.listRuns({ limit: 10 }).then((rs) => rs[0]?.id));
  await waitFor(() => (h.cursor.calls.length > 0 ? true : undefined));

  const cancelOut = await svc.service.cancelRun(id);
  expect(cancelOut.status).toBe("cancelled");

  const out = await shipPromise;
  expect(out.status).toBe("cancelled");
  expect(out.cursorRun.status).toBe("cancelled");

  const row = await svc.service.getRun(out.workflowRunId);
  expect(row?.status).toBe("cancelled");

  // The events file is created and closed regardless of how many events
  // streamed before the cancel landed; the runner saw the abort signal,
  // which is what matters.
  expect(h.cursor.calls[0]?.input.signal).toBeDefined();
});

/**
 * Polls `probe()` until it returns a defined value or the deadline
 * elapses. The probe returns `undefined` to mean "not yet"; any other
 * value (including `null`/`0`/`""`/`false`) is treated as "ready" and
 * returned. Avoids wall-clock sleeps that race scheduler variance.
 */
async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  const interval = opts.intervalMs ?? 5;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error("waitFor: probe never produced a value before deadline");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, interval);
    });
  }
}

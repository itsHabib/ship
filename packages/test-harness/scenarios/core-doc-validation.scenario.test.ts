/**
 * Cross-package scenario: pre-row doc validation through `ShipService`.
 * Asserts that an absolute `docPath` resolving outside `workdir` is
 * rejected with `DocPathEscapesWorkdirError`, no row is created, and
 * the cursor runner is never invoked.
 */

import { DocPathEscapesWorkdirError } from "@ship/core";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { Harness, ServiceBundle } from "../src/index.js";

import { createHarness, createServiceFromHarness } from "../src/index.js";

const WORKDIR = "/work/wt/escape";
const SIBLING = "/work/elsewhere.md";

let h: Harness;
let svc: ServiceBundle;

beforeEach(async () => {
  h = createHarness();
  svc = createServiceFromHarness(h);
  await svc.fs.mkdir(WORKDIR, { recursive: true });
  // Sibling lives outside the workdir; the absolute docPath must reject.
  await svc.fs.mkdir("/work", { recursive: true });
  await svc.fs.writeFile(SIBLING, "outside");
});

afterEach(() => {
  h.close();
});

test("docPath that resolves outside workdir → throws; no row created; cursor.run not invoked", async () => {
  await expect(
    svc.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: SIBLING,
    }),
  ).rejects.toBeInstanceOf(DocPathEscapesWorkdirError);

  expect(await svc.service.listRuns({ limit: 10 })).toHaveLength(0);
  expect(h.cursor.calls).toHaveLength(0);
});

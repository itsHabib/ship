/**
 * L4 live e2e A3 — cancel a long `ship` run after SDK traffic appears in
 * `events.ndjson`, using the real Cursor SDK + `ship cancel`.
 *
 * **Quota:** 1× partial Cursor run (cancelled) per execution.
 */

import type { ShipOutput } from "@ship/mcp";

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  bootstrapFixtureMainOnSandbox,
  Env,
  hasOpenPrLiveEnv,
  mkLiveTmp,
  ndjsonSuggestsAgentStarted,
  parseSandboxSlug,
  parseWorkflowRun,
  runCli,
  runCliSync,
  spawnShipChild,
  waitForEventsNdjsonPredicate,
  waitForWorkflowRowId,
} from "./live-open-pr-helpers.js";

const LIVE = hasOpenPrLiveEnv();

describe.skipIf(!LIVE)("L4 live e2e — A3 cancel in-flight ship", () => {
  const slug = Env.sandbox;

  test("cancel after events.ndjson shows assistant/tool traffic → workflow cancelled", async () => {
    parseSandboxSlug(slug);
    const { root: homeRoot, workdir } = mkLiveTmp("ship-l4-a3-");
    const branch = `tower/live-e2e-${randomBytes(8).toString("hex")}`;
    const repoLabel = `l4-cancel-${randomBytes(4).toString("hex")}`;

    bootstrapFixtureMainOnSandbox({ workdir, token: Env.github, sandboxSlug: slug });

    const s = spawnShipChild({
      homeRoot,
      workdir,
      repoLabel,
      branch,
      docRel: "docs/features/long.md",
    });
    try {
      const wfId = await waitForWorkflowRowId(homeRoot, repoLabel);

      const eventsPath = await waitForEventsNdjsonPredicate({
        homeRoot,
        predicate: (_path, content) =>
          content.split("\n").some((l) => ndjsonSuggestsAgentStarted(l)),
        timeoutMs: 120_000,
      });
      const beforeCancel = Date.now();
      const cancelR = await runCli(homeRoot, ["cancel", wfId, "--json"]);
      expect(cancelR.code).toBe(0);

      const { exitCode, stdout } = await s.waitForClose();
      const closedAt = Date.now();
      expect(exitCode).toBe(0);
      expect(closedAt - beforeCancel).toBeLessThan(30_000);
      const shipOut = JSON.parse(stdout.trim()) as ShipOutput;
      expect(shipOut.status).toBe("cancelled");

      const st = runCliSync(homeRoot, ["status", wfId, "--json"]);
      expect(st.code).toBe(0);
      const run = parseWorkflowRun(st.stdout);
      expect(run.status).toBe("cancelled");

      const raw = readFileSync(eventsPath, "utf-8");
      expect(/abort/i.test(raw)).toBe(true);
    } finally {
      s.stop();
    }
  });
});

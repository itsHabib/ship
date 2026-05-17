/**
 * L4 live e2e A3 — cancel a long `ship` run after SDK traffic appears in
 * `events.ndjson`, using the real Cursor SDK + `ship cancel`.
 *
 * **Quota:** 1× partial Cursor run (cancelled) per execution.
 */

import type { ShipOutput } from "@ship/mcp";

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { findEventsNdjson, startEventTailer } from "./event-tailer.js";
import {
  bootstrapFixtureMainOnSandbox,
  CLI_BIN,
  CLI_PKG,
  Env,
  hasOpenPrLiveEnv,
  isolatedHomeEnv,
  mkLiveTmp,
  ndjsonSuggestsAgentStarted,
  parseSandboxSlug,
  parseWorkflowRun,
  runCli,
  runCliSync,
  sleep,
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

    const env = isolatedHomeEnv(homeRoot);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        CLI_BIN,
        "ship",
        "docs/features/long.md",
        "--workdir",
        workdir,
        "--repo",
        repoLabel,
        "--branch",
        branch,
        "--json",
        "--thinking",
        "low",
      ],
      {
        cwd: CLI_PKG,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let shipStdout = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (c: string) => {
      shipStdout += c;
      process.stdout.write(c);
    });
    child.stderr.on("data", (c: string) => {
      process.stderr.write(`[ship-stderr] ${c}`);
    });
    const tailer = startEventTailer(homeRoot, child);
    try {
      const wfId = await waitForWorkflowRowId(homeRoot, repoLabel);

      const eventsPath = await waitForNdjsonAgentSignal(homeRoot);
      const beforeCancel = Date.now();
      const cancelR = await runCli(homeRoot, ["cancel", wfId, "--json"]);
      expect(cancelR.code).toBe(0);

      let closedAt = 0;
      const exitCode = await new Promise<number>((res) => {
        child.on("close", (c) => {
          closedAt = Date.now();
          res(c ?? -1);
        });
      });
      expect(exitCode).toBe(0);
      expect(closedAt - beforeCancel).toBeLessThan(30_000);
      const shipOut = JSON.parse(shipStdout.trim()) as ShipOutput;
      expect(shipOut.status).toBe("cancelled");

      const st = runCliSync(homeRoot, ["status", wfId, "--json"]);
      expect(st.code).toBe(0);
      const run = parseWorkflowRun(st.stdout);
      expect(run.status).toBe("cancelled");

      const raw = readFileSync(eventsPath, "utf-8");
      expect(/abort/i.test(raw)).toBe(true);
    } finally {
      tailer.stop();
    }
  });
});

async function waitForNdjsonAgentSignal(homeRoot: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const p = findEventsNdjson(homeRoot);
    if (p !== undefined && ndjsonFileShowsAgentActivity(p)) return p;
    await sleep(250);
  }
  throw new Error("timed out waiting for assistant/tool events in ndjson");
}

function ndjsonFileShowsAgentActivity(absPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(absPath, "utf-8");
  } catch {
    return false;
  }
  return text.split("\n").some((line) => ndjsonSuggestsAgentStarted(line));
}

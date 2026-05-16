/**
 * In-process integration test: real `node:fs` + real SQLite file on
 * disk + `FakeCursorRunner` injected via `createCliService`'s cursor
 * override. Catches CLI ↔ store ↔ fs interactions the in-memory
 * scenario tests can't see (real path separators, real WAL/journal
 * files, real `mkdir` recursion, real artifact persistence).
 */

import type { Command } from "commander";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildProgram } from "../../packages/cli/src/program.js";
import { createCliOpenPrService, createCliService } from "../../packages/cli/src/service.js";

interface IntHarness {
  program: Command;
  cursor: FakeCursorRunner;
  workdir: string;
  dbPath: string;
  runsDir: string;
}

function createIntHarness(): IntHarness {
  const tmp = mkdtempSync(join(tmpdir(), "ship-int-real-"));
  const dbPath = join(tmp, "state.db");
  const runsDir = join(tmp, "runs");
  const workdir = join(tmp, "work");
  const cursor = new FakeCursorRunner();
  const factory = createCliService({ dbPath, runsDir, cursor });
  const openPrFactory = createCliOpenPrService({ dbPath });
  const program = buildProgram(factory, openPrFactory);
  return { program, cursor, workdir, dbPath, runsDir };
}

let h: IntHarness;
const stdout: string[] = [];
let origStdout: typeof process.stdout.write;

beforeEach(() => {
  h = createIntHarness();
  // Create the workdir + a doc on real disk so validate.ts can stat it.
  mkdirSync(h.workdir, { recursive: true });
  writeFileSync(join(h.workdir, "docs.md"), "# Integration test\n\nDo it.\n");
  stdout.length = 0;
  origStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(() => {
  process.stdout.write = origStdout;
});

describe("CLI integration: real disk + real SQLite + fake cursor", () => {
  test("ship → list → status round-trip persists artifacts to real disk", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, summary: "shipped", branches: [] },
    });

    await h.program.parseAsync([
      "node",
      "ship",
      "ship",
      "docs.md",
      "--workdir",
      h.workdir,
      "--repo",
      "ship",
      "--json",
    ]);
    const shipOut = JSON.parse(stdout.join("").trim()) as {
      workflowRunId: string;
      artifacts: { promptPath: string; eventsPath: string; resultPath: string };
    };

    // Real-disk artifact assertions.
    expect(statSync(shipOut.artifacts.promptPath).isFile()).toBe(true);
    expect(statSync(shipOut.artifacts.resultPath).isFile()).toBe(true);
    expect(readFileSync(shipOut.artifacts.promptPath, "utf-8")).toContain("Repo: ship");
    expect(
      JSON.parse(readFileSync(shipOut.artifacts.resultPath, "utf-8")) as { status: string },
    ).toMatchObject({ status: "succeeded" });

    // The runs dir should now have one subdirectory keyed by workflowRunId.
    const runDirs = readdirSync(h.runsDir);
    expect(runDirs).toContain(shipOut.workflowRunId);

    // SQLite db file actually exists on disk.
    expect(statSync(h.dbPath).isFile()).toBe(true);
  });

  test("two sequential ships against the same db both land", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    await h.program.parseAsync([
      "node",
      "ship",
      "ship",
      "docs.md",
      "--workdir",
      h.workdir,
      "--repo",
      "ship",
      "--json",
    ]);
    stdout.length = 0;
    await h.program.parseAsync([
      "node",
      "ship",
      "ship",
      "docs.md",
      "--workdir",
      h.workdir,
      "--repo",
      "ship",
      "--json",
    ]);
    stdout.length = 0;

    // List should see both.
    await h.program.parseAsync(["node", "ship", "list", "--json"]);
    const listOut = JSON.parse(stdout.join("").trim()) as { runs: unknown[] };
    expect(listOut.runs).toHaveLength(2);
  });
});

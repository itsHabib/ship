/** Cross-process `ship driver list` reads durable SQLite state. */

import { closeDefaultSharedStore } from "@ship/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CliExit } from "../src/errors.js";
import { buildProgram } from "../src/program.js";
import { createCliDriverService, createCliService } from "../src/service.js";
import { writeOneStreamManifest } from "./driver-fixtures.js";

let tmp: string;
const stdout: string[] = [];
let origStdout: typeof process.stdout.write;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "driver-list-xproc-"));
  stdout.length = 0;
  origStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(() => {
  process.stdout.write = origStdout;
  closeDefaultSharedStore(join(tmp, "state.db"));
  rmSync(tmp, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
});

async function runList(dbPath: string, runsDir: string): Promise<number> {
  const shipFactory = createCliService({ dbPath, runsDir });
  const program = buildProgram(
    shipFactory,
    createCliDriverService({ dbPath, runsDir }, shipFactory),
  );
  try {
    await program.parseAsync(["node", "ship", "driver", "list", "--json"]);
    return 0;
  } catch (err) {
    if (err instanceof CliExit) return err.code;
    throw err;
  }
}

describe("ship driver list cross-process", () => {
  test("reader process lists rows written and closed by a writer process", async () => {
    const dbPath = join(tmp, "state.db");
    const runsDir = join(tmp, "runs");
    const repoRoot = join(tmp, "repo");
    const layout = writeOneStreamManifest(repoRoot);

    const writerFactory = createCliService({ dbPath, runsDir });
    const writerProgram = buildProgram(
      writerFactory,
      createCliDriverService({ dbPath, runsDir }, writerFactory),
    );
    await writerProgram.parseAsync(["node", "ship", "driver", "import", layout.manifestPath]);
    closeDefaultSharedStore(dbPath);

    stdout.length = 0;
    expect(await runList(dbPath, runsDir)).toBe(0);
    const parsed = JSON.parse(stdout.join("").trim()) as {
      runs: { driverRunId: string; batches: { streams: { specPath: string }[] }[] }[];
    };
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.batches[0]?.streams[0]?.specPath).toBe("docs/task.md");
  });
});

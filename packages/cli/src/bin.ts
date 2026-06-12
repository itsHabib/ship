#!/usr/bin/env node
/**
 * Ship CLI entrypoint. Wires the production service factory and
 * hands argv to the Commander program. Maps `CliExit` (and any
 * stray throw) to `process.exitCode` so the shell sees the right
 * exit status.
 */

import type { CursorRunner } from "@ship/cursor-runner";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createLogger } from "@ship/logger";
import { CommanderError } from "commander";

import { CliExit } from "./errors.js";
import { buildProgram } from "./program.js";
import {
  createCliDriverService,
  createCliService,
  resolveDbPath,
  resolveRunsDir,
} from "./service.js";

async function main(): Promise<void> {
  const logger = createLogger({ stream: process.stderr });
  const dbPath = resolveDbPath();
  const runsDir = resolveRunsDir();
  const useFake = process.env["SHIP_TEST_FAKE_CURSOR"] === "1";
  // One fake serves both runtimes — cloud-runtime driver streams must
  // not construct a real CloudCursorRunner in fake mode.
  const fakeCursor = useFake ? createFakeCursorRunner() : undefined;
  const serviceOpts = {
    dbPath,
    runsDir,
    logger,
    ...(fakeCursor !== undefined ? { cursor: fakeCursor, cloudCursor: fakeCursor } : {}),
  };
  const factory = createCliService(serviceOpts);
  const driverFactory = createCliDriverService(serviceOpts, factory);
  const program = buildProgram(factory, driverFactory);
  await program.parseAsync(process.argv);
}

function createFakeCursorRunner(): CursorRunner {
  return new FakeCursorRunner({
    defaultScript: {
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    },
  });
}

main().catch((err: unknown) => {
  if (err instanceof CliExit) {
    process.exitCode = err.code;
    return;
  }
  if (err instanceof CommanderError) {
    // `--help` and `--version` throw `CommanderError` with
    // `exitCode: 0`; pass the code through directly. Earlier versions
    // used `err.exitCode || 1` here, which silently flipped a
    // legitimate 0 to 1 because `0` is falsy.
    process.exitCode = err.exitCode;
    return;
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});

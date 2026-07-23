#!/usr/bin/env node
/**
 * Ship CLI entrypoint. Wires the production service factory and
 * hands argv to the Commander program. Maps `CliExit` (and any
 * stray throw) to `process.exitCode` so the shell sees the right
 * exit status.
 */

import type { AgentRunner } from "@ship/cursor-runner";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createExecTriageClassifier } from "@ship/driver";
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
  // One fake serves every runtime — cloud- and rooms-runtime streams must
  // not construct a real CloudCursorRunner / RoomCursorRunner (which shells
  // out to `rooms`/sudo) in fake mode.
  const fakeCursor = useFake ? createFakeCursorRunner() : undefined;
  const serviceOpts = {
    dbPath,
    runsDir,
    logger,
    ...(fakeCursor !== undefined
      ? { cursor: fakeCursor, cloudCursor: fakeCursor, roomCursor: fakeCursor }
      : {}),
  };
  const factory = createCliService(serviceOpts);
  // Real triage classifier in production only — fake mode never shells out to
  // gh / triage-floor.
  const triage = useFake ? undefined : createExecTriageClassifier();
  const driverFactory = createCliDriverService(serviceOpts, factory, undefined, triage);
  const program = buildProgram(factory, driverFactory);
  await program.parseAsync(process.argv);
}

function createFakeCursorRunner(): AgentRunner {
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

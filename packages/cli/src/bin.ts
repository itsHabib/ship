#!/usr/bin/env node
/**
 * Ship CLI entrypoint. Wires the production service factory and
 * hands argv to the Commander program. Maps `CliExit` (and any
 * stray throw) to `process.exitCode` so the shell sees the right
 * exit status.
 */

import { createLogger } from "@ship/logger";
import { CommanderError } from "commander";

import { CliExit } from "./errors.js";
import { buildProgram } from "./program.js";
import { createCliService, resolveDbPath, resolveRunsDir } from "./service.js";

async function main(): Promise<void> {
  const logger = createLogger({ stream: process.stderr });
  const factory = createCliService({
    dbPath: resolveDbPath(),
    runsDir: resolveRunsDir(),
    logger,
  });
  const program = buildProgram(factory);
  await program.parseAsync(process.argv);
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

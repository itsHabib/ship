#!/usr/bin/env node
/**
 * Ship CLI entrypoint. Wires the production service factory and
 * hands argv to the Commander program. Maps `CliExit` (and any
 * stray throw) to `process.exit(code)` so the shell sees the right
 * exit status.
 */

import { CommanderError } from "commander";

import { CliExit } from "./errors.js";
import { buildProgram } from "./program.js";
import { createCliService, resolveDbPath, resolveRunsDir } from "./service.js";

async function main(): Promise<void> {
  const factory = createCliService({
    dbPath: resolveDbPath(),
    runsDir: resolveRunsDir(),
  });
  const program = buildProgram(factory);
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof CliExit) {
    process.exit(err.code);
  }
  if (err instanceof CommanderError) {
    process.exit(err.exitCode || 1);
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});

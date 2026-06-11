/** `ship prune` — delete terminal run artifacts older than a cutoff. */

import type { Command } from "commander";

import { PruneDurationError } from "@ship/core";

import type { ServiceFactory } from "../service.js";

import { cliExit, InvalidArgumentError, toCliExitCode } from "../errors.js";
import { formatPruneOutput } from "../format.js";

interface PruneOpts {
  before?: string;
  dryRun?: boolean;
  json?: boolean;
}

export function registerPruneCommand(program: Command, factory: ServiceFactory): void {
  program
    .command("prune")
    .description("delete terminal run artifacts older than a cutoff")
    .requiredOption("--before <duration>", "age cutoff (e.g. 30d, 12h, 2w, 45m)")
    .option("--dry-run", "print would-delete rows without changing anything")
    .option("--json", "emit machine-readable JSON")
    .action(async (rawOpts: PruneOpts) => {
      try {
        const before = rawOpts.before;
        if (before === undefined || before.trim() === "") {
          throw new InvalidArgumentError("missing required option --before");
        }
        const out = await factory().pruneRuns({
          before,
          dryRun: rawOpts.dryRun === true,
        });
        process.stdout.write(`${formatPruneOutput(out, rawOpts.json === true)}\n`);
      } catch (err) {
        const mapped =
          err instanceof PruneDurationError ? new InvalidArgumentError(err.message) : err;
        const code = toCliExitCode(mapped);
        process.stderr.write(`${mapped instanceof Error ? mapped.message : String(mapped)}\n`);
        cliExit(code);
      }
    });
}

/** `ship diagnose <workflowRunId>` — one-view failure diagnosis for a run. */

import type { Command } from "commander";

import type { ServiceFactory } from "../service.js";

import { cliExit, toCliExitCode } from "../errors.js";
import { formatDiagnoseRun } from "../format.js";

export function registerDiagnoseCommand(program: Command, factory: ServiceFactory): void {
  program
    .command("diagnose <workflowRunId>")
    .description("render failure diagnosis fields for one run")
    .option("--json", "emit machine-readable JSON instead of pretty output")
    .action(async (workflowRunId: string, rawOpts: { json: boolean }) => {
      try {
        const run = await factory().getRun(workflowRunId);
        if (run === null) {
          process.stderr.write(`not found: ${workflowRunId}\n`);
          cliExit(1);
        }
        process.stdout.write(`${formatDiagnoseRun(run, rawOpts.json)}\n`);
      } catch (err) {
        const code = toCliExitCode(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });
}

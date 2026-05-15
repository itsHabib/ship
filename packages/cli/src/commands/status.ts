/** `ship status <workflowRunId>` — fetch the durable state of one run. */

import type { Command } from "commander";

import type { ServiceFactory } from "../service.js";

import { cliExit, toCliExitCode } from "../errors.js";
import { formatWorkflowRun } from "../format.js";

export function registerStatusCommand(program: Command, factory: ServiceFactory): void {
  program
    .command("status <workflowRunId>")
    .description("fetch the durable state of one run")
    .option("--json", "emit machine-readable JSON instead of pretty output")
    .action(async (workflowRunId: string, rawOpts: { json: boolean }) => {
      try {
        const run = await factory().getRun(workflowRunId);
        if (run === null) {
          process.stderr.write(`not found: ${workflowRunId}\n`);
          cliExit(1);
        }
        process.stdout.write(`${formatWorkflowRun(run, rawOpts.json)}\n`);
      } catch (err) {
        const code = toCliExitCode(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });
}

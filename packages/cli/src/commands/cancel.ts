/** `ship cancel <workflowRunId>` — cancel an in-flight run. Idempotent. */

import type { Command } from "commander";

import type { ServiceFactory } from "../service.js";

import { cliExit, rethrowCliExitOrMap } from "../errors.js";
import { formatCancelOutput } from "../format.js";

export function registerCancelCommand(program: Command, factory: ServiceFactory): void {
  program
    .command("cancel <workflowRunId>")
    .description("cancel an in-flight run; idempotent on terminal rows")
    .option("--json", "emit machine-readable JSON instead of pretty output")
    .action(async (workflowRunId: string, rawOpts: { json: boolean }) => {
      try {
        const out = await factory().cancelRun(workflowRunId);
        process.stdout.write(`${formatCancelOutput(out, rawOpts.json)}\n`);
      } catch (err) {
        const code = rethrowCliExitOrMap(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });
}

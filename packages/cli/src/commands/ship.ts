/**
 * `ship ship <docPath>` — start a workflow run. Maps argv to
 * `ShipService.ship` and prints the resulting `ShipOutput`.
 */

import type { Command } from "commander";

import { resolve as resolvePath } from "node:path";

import type { ServiceFactory } from "../service.js";

import { cliExit, rethrowCliExitOrMap } from "../errors.js";
import { formatShipOutput } from "../format.js";

interface ShipOpts {
  workdir: string;
  repo: string;
  branch?: string;
  baseRef?: string;
  worktreeName?: string;
  model?: string;
  json: boolean;
}

export function registerShipCommand(program: Command, factory: ServiceFactory): void {
  program
    .command("ship <docPath>")
    .description("start a workflow run from an approved task doc")
    .option("--workdir <path>", "absolute path of the workspace", ".")
    .requiredOption("--repo <name>", "repo name (label, not validated)")
    .option("--branch <name>", "branch the run targets")
    .option("--base-ref <ref>", "git ref the worktree branched from")
    .option("--worktree-name <name>", "worktree slug")
    .option("--model <id>", "Cursor model id (e.g. composer-2)")
    .option("--json", "emit machine-readable JSON instead of pretty output")
    .action(async (docPath: string, rawOpts: ShipOpts) => {
      try {
        const out = await factory().ship({
          workdir: resolvePath(rawOpts.workdir),
          repo: rawOpts.repo,
          docPath,
          ...(rawOpts.branch !== undefined && { branch: rawOpts.branch }),
          ...(rawOpts.baseRef !== undefined && { baseRef: rawOpts.baseRef }),
          ...(rawOpts.worktreeName !== undefined && { worktreeName: rawOpts.worktreeName }),
          ...(rawOpts.model !== undefined && { model: rawOpts.model }),
        });
        process.stdout.write(`${formatShipOutput(out, rawOpts.json)}\n`);
      } catch (err) {
        const code = rethrowCliExitOrMap(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });
}

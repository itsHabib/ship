// `ship open-pr <workflowRunId>` — open a PR for an existing
// workflow run's branch. Mirrors the MCP `open_pr` tool surface.

import type { OpenPrServiceFactory } from "@ship/core";
import type { Command } from "commander";

import { cliExit, toCliExitCode } from "../errors.js";
import { formatOpenPrOutput } from "../format.js";

interface OpenPrOpts {
  base?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  json: boolean;
}

export function registerOpenPrCommand(program: Command, factory: OpenPrServiceFactory): void {
  program
    .command("open-pr <workflowRunId>")
    .description("push the run's branch and open a PR via the GitHub REST API")
    .option(
      "--base <ref>",
      "override the PR's base branch (default: resolved from git config / origin/HEAD)",
    )
    .option("--title <text>", "override the derived PR title")
    .option("--body <text>", "override the derived PR body")
    .option("--draft", "open the PR as a draft", false)
    .option("--json", "emit machine-readable JSON instead of pretty output")
    .action(async (workflowRunId: string, rawOpts: OpenPrOpts) => {
      try {
        // `--draft` defaults to false at commander's level so
        // `rawOpts.draft` is always a boolean. The other optionals
        // stay conditional so the service's own defaults apply when
        // the flag was absent.
        const out = await factory().openPr({
          workflowRunId,
          draft: rawOpts.draft ?? false,
          ...(rawOpts.base !== undefined && { base: rawOpts.base }),
          ...(rawOpts.title !== undefined && { title: rawOpts.title }),
          ...(rawOpts.body !== undefined && { body: rawOpts.body }),
        });
        process.stdout.write(`${formatOpenPrOutput(out, rawOpts.json)}\n`);
      } catch (err) {
        const code = toCliExitCode(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });
}

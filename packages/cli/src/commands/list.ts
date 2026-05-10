/** `ship list` — list workflow runs with optional filters. */

import type { ListRunsFilter } from "@ship/core";
import type { WorkflowStatus } from "@ship/workflow";
import type { Command } from "commander";

import type { ServiceFactory } from "../service.js";

import { cliExit, rethrowCliExitOrMap } from "../errors.js";
import { formatWorkflowRunList } from "../format.js";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

interface ListOpts {
  repo?: string;
  status?: string[];
  limit?: string;
  json: boolean;
}

export function registerListCommand(program: Command, factory: ServiceFactory): void {
  program
    .command("list")
    .description("list workflow runs (most recent first)")
    .option("--repo <name>", "filter by repo")
    .option(
      "--status <status>",
      "filter by status (repeat for multiple)",
      (value: string, prior: string[] | undefined): string[] => [...(prior ?? []), value],
    )
    .option("--limit <n>", "max rows (server cap is 200)")
    .option("--json", "emit machine-readable JSON instead of a table")
    .action(async (rawOpts: ListOpts) => {
      try {
        const filter = buildFilter(rawOpts);
        const runs = await factory().listRuns(filter);
        process.stdout.write(`${formatWorkflowRunList(runs, rawOpts.json)}\n`);
      } catch (err) {
        const code = rethrowCliExitOrMap(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });
}

function buildFilter(opts: ListOpts): ListRunsFilter {
  const filter: ListRunsFilter = {};
  if (opts.repo !== undefined) filter.repo = opts.repo;
  if (opts.status !== undefined && opts.status.length > 0) {
    for (const s of opts.status) {
      if (!VALID_STATUSES.has(s)) {
        throw new Error(`invalid --status: ${s}`);
      }
    }
    filter.status = opts.status as WorkflowStatus[];
  }
  if (opts.limit !== undefined) {
    const parsed = Number.parseInt(opts.limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid --limit: ${opts.limit}`);
    }
    filter.limit = parsed;
  }
  return filter;
}

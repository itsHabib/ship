/** `ship artifacts list|download` — cloud artifact manifest and retrieval. */

import type { ArtifactRef } from "@ship/workflow";
import type { Command } from "commander";

import type { ServiceFactory } from "../service.js";

import { cliExit, toCliExitCode } from "../errors.js";

export function registerArtifactsCommand(program: Command, factory: ServiceFactory): void {
  const artifacts = program
    .command("artifacts")
    .description("list or download cloud-produced artifacts for a workflow run");

  artifacts
    .command("list")
    .argument("<workflowRunId>", "workflow run id")
    .description("list persisted artifact refs (path / size / updatedAt)")
    .option("--json", "emit machine-readable JSON")
    .action(async (workflowRunId: string, rawOpts: { json: boolean }) => {
      try {
        const rows = await factory().listArtifacts(workflowRunId);
        process.stdout.write(`${formatArtifactList(rows, rawOpts.json)}\n`);
      } catch (err) {
        const code = toCliExitCode(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });

  artifacts
    .command("download")
    .argument("<workflowRunId>", "workflow run id")
    .argument("<path>", "SDK artifact path from list")
    .description("download artifact bytes to the run artifacts directory")
    .option("--out <dir>", "write under this directory instead of the run dir")
    .option("--force", "bypass the size preflight guard")
    .option("--json", "emit machine-readable JSON for the result")
    .action(
      async (
        workflowRunId: string,
        path: string,
        rawOpts: { out?: string; force?: boolean; json?: boolean },
      ) => {
        try {
          const out = await factory().downloadArtifact(workflowRunId, path, {
            ...(rawOpts.out !== undefined && { outDir: rawOpts.out }),
            ...(rawOpts.force === true && { force: true }),
          });
          if (rawOpts.json === true) {
            process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
          } else {
            process.stdout.write(`${out.localPath}\n`);
          }
        } catch (err) {
          const code = toCliExitCode(err);
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          cliExit(code);
        }
      },
    );
}

function formatArtifactList(artifacts: readonly ArtifactRef[], json: boolean): string {
  if (json) return JSON.stringify({ artifacts }, null, 2);
  if (artifacts.length === 0) return "(no artifacts)";
  const header = `${pad("PATH", 40)}  ${pad("SIZE", 12)}  UPDATED`;
  const rows = artifacts.map(
    (a) => `${pad(a.path, 40)}  ${pad(String(a.sizeBytes), 12)}  ${a.updatedAt}`,
  );
  return [header, ...rows].join("\n");
}

function pad(value: string, width: number): string {
  if (value.length >= width) return `${value.slice(0, Math.max(0, width - 1))}…`;
  return value + " ".repeat(width - value.length);
}

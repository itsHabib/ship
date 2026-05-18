/**
 * `ship ship <docPath>` — start a workflow run. Maps argv to
 * `ShipService.ship` and prints the resulting `ShipOutput`.
 */

import type { ShipInput, ThinkingEffort } from "@ship/mcp";
import type { Command } from "commander";

import { cloudRunSpecSchema, thinkingEffortSchema } from "@ship/mcp";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type { ServiceFactory } from "../service.js";

import { cliExit, InvalidArgumentError, toCliExitCode } from "../errors.js";
import { formatShipOutput } from "../format.js";

/** Wire shape for `ShipInput.cloud` — matches `cloudRunSpecSchema`; narrowed for `ShipService`. */
type ShipCloud = NonNullable<ShipInput["cloud"]>;

interface ShipOpts {
  workdir: string;
  repo: string;
  branch?: string;
  baseRef?: string;
  worktreeName?: string;
  model?: string;
  thinking?: string;
  json: boolean;
  runtime?: string;
  /** `--cloud` JSON file path; when set, other `--cloud-*` field flags are ignored. */
  cloud?: string;
  cloudRepo?: string;
  cloudAutoCreatePr?: boolean;
  cloudSkipReviewerRequest?: boolean;
  cloudEnvVar?: string[];
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
    .option("--thinking <effort>", "Cursor thinking effort (low|high); defaults to high")
    .option("--runtime <mode>", "cursor runtime (local|cloud); omit to use service default")
    .option(
      "--cloud <path>",
      "JSON file with full CloudRunSpec (via cloudRunSpecSchema); when set, ignores --cloud-repo and other --cloud-* field flags",
    )
    .option("--cloud-repo <url>", "cloud: single repo URL (maps to cloud.repos[0].url)")
    .option("--cloud-auto-create-pr", "cloud: set autoCreatePR true (field-flag mode only)")
    .option(
      "--cloud-skip-reviewer-request",
      "cloud: set skipReviewerRequest true (field-flag mode only)",
    )
    .option(
      "--cloud-env-var <pair>",
      "cloud: session env KEY=VAL (split on first '=' only; repeatable; last key wins)",
      collectPair,
      [] as string[],
    )
    .option("--json", "emit machine-readable JSON instead of pretty output")
    .action(async (docPath: string, rawOpts: ShipOpts) => {
      try {
        const thinking = parseThinking(rawOpts.thinking);
        const runtime = parseRuntime(rawOpts.runtime);
        const cloud = await resolveCloudSpec(rawOpts);
        const out = await factory().ship({
          workdir: resolvePath(rawOpts.workdir),
          repo: rawOpts.repo,
          docPath,
          ...(rawOpts.branch !== undefined && { branch: rawOpts.branch }),
          ...(rawOpts.baseRef !== undefined && { baseRef: rawOpts.baseRef }),
          ...(rawOpts.worktreeName !== undefined && { worktreeName: rawOpts.worktreeName }),
          ...(rawOpts.model !== undefined && { model: rawOpts.model }),
          ...(thinking !== undefined && { thinking }),
          ...(runtime !== undefined && { runtime }),
          ...(cloud !== undefined && { cloud }),
        });
        process.stdout.write(`${formatShipOutput(out, rawOpts.json)}\n`);
      } catch (err) {
        const code = toCliExitCode(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });
}

function collectPair(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseThinking(raw: string | undefined): ThinkingEffort | undefined {
  if (raw === undefined) return undefined;
  const result = thinkingEffortSchema.safeParse(raw);
  if (!result.success) {
    throw new InvalidArgumentError(`invalid --thinking: ${raw} (expected: low | high)`);
  }
  return result.data;
}

/** Mirrors `parseThinking`: omit flag → undefined (service default); invalid → InvalidArgumentError. */
function parseRuntime(raw: string | undefined): "local" | "cloud" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "local" || raw === "cloud") return raw;
  throw new InvalidArgumentError(`invalid --runtime: ${raw} (expected: local | cloud)`);
}

function hasCloudFieldFlags(opts: ShipOpts): boolean {
  return (
    opts.cloudRepo !== undefined ||
    opts.cloudAutoCreatePr === true ||
    opts.cloudSkipReviewerRequest === true ||
    (opts.cloudEnvVar !== undefined && opts.cloudEnvVar.length > 0)
  );
}

function parseCloudEnvPair(raw: string): [string, string] {
  const idx = raw.indexOf("=");
  if (idx <= 0) {
    throw new InvalidArgumentError(`invalid --cloud-env-var: ${raw} (expected KEY=VAL)`);
  }
  const key = raw.slice(0, idx);
  const val = raw.slice(idx + 1);
  if (key.length === 0) {
    throw new InvalidArgumentError(`invalid --cloud-env-var: ${raw} (expected KEY=VAL)`);
  }
  return [key, val];
}

function buildCloudRunSpecFromFlags(opts: ShipOpts): ShipCloud {
  const draft: Record<string, unknown> = {};
  if (opts.cloudRepo !== undefined) {
    draft["repos"] = [{ url: opts.cloudRepo }];
  }
  if (opts.cloudAutoCreatePr === true) {
    draft["autoCreatePR"] = true;
  }
  if (opts.cloudSkipReviewerRequest === true) {
    draft["skipReviewerRequest"] = true;
  }
  const pairs = opts.cloudEnvVar ?? [];
  if (pairs.length > 0) {
    const envVars: Record<string, string> = {};
    for (const p of pairs) {
      const [k, v] = parseCloudEnvPair(p);
      envVars[k] = v;
    }
    draft["envVars"] = envVars;
  }
  return cloudRunSpecSchema.parse(draft);
}

async function loadCloudRunSpecFromFile(pathArg: string): Promise<ShipCloud> {
  const absolute = resolvePath(pathArg);
  let text: string;
  try {
    text = await readFile(absolute, "utf-8");
  } catch {
    throw new InvalidArgumentError(`cannot read --cloud file: ${absolute}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidArgumentError(`invalid JSON in --cloud file: ${msg}`);
  }
  return cloudRunSpecSchema.parse(parsed);
}

async function resolveCloudSpec(opts: ShipOpts): Promise<ShipCloud | undefined> {
  if (opts.cloud !== undefined) {
    return await loadCloudRunSpecFromFile(opts.cloud);
  }
  if (!hasCloudFieldFlags(opts)) {
    return undefined;
  }
  return buildCloudRunSpecFromFlags(opts);
}

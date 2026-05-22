/**
 * `ship ship <docPath>` — start a workflow run. Maps argv to
 * `ShipService.ship` and prints the resulting `ShipOutput`.
 */

import type { ShipInput } from "@ship/mcp";
import type { Command } from "commander";

import { cloudRunSpecSchema } from "@ship/mcp";
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
  modelParam?: string[];
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
    .option("--model <id>", "Cursor model id (e.g. composer-2.5)")
    .option(
      "--model-param <pair>",
      "model KEY=VAL (split on first '=' only; repeatable; last key wins; true/false → booleans)",
      collectPair,
      [] as string[],
    )
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
        const input = await buildShipCliInput(rawOpts, docPath);
        const out = await factory().ship(input);
        process.stdout.write(`${formatShipOutput(out, rawOpts.json)}\n`);
      } catch (err) {
        const code = toCliExitCode(err);
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        cliExit(code);
      }
    });
}

async function buildShipCliInput(opts: ShipOpts, docPath: string): Promise<ShipInput> {
  const modelParamsRaw = opts.modelParam ?? [];
  const modelParams = modelParamsRaw.length > 0 ? accumulateModelParams(modelParamsRaw) : undefined;

  const runtime = parseRuntime(opts.runtime);
  const cloud = await resolveCloudSpec(opts, runtime);
  return {
    workdir: resolvePath(opts.workdir),
    repo: opts.repo,
    docPath,
    ...(opts.branch !== undefined && { branch: opts.branch }),
    ...(opts.baseRef !== undefined && { baseRef: opts.baseRef }),
    ...(opts.worktreeName !== undefined && { worktreeName: opts.worktreeName }),
    ...(opts.model !== undefined && { model: opts.model }),
    ...(modelParams !== undefined && { modelParams }),
    ...(runtime !== undefined && { runtime }),
    ...(cloud !== undefined && { cloud }),
  };
}

function collectPair(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function accumulateModelParams(pairs: string[]): NonNullable<ShipInput["modelParams"]> {
  const m = new Map<string, NonNullable<ShipInput["modelParams"]>[number]>();
  for (const p of pairs) {
    const parsed = parseModelParam(p);
    m.set(parsed.id, parsed);
  }
  return [...m.values()];
}

/** Split on first `=` only; boolean values for lowercase `true` / `false`; otherwise string. */
function parseModelParam(raw: string): { id: string; value: string | boolean } {
  const idx = raw.indexOf("=");
  if (idx <= 0) {
    throw new InvalidArgumentError(`invalid --model-param: ${raw} (expected KEY=VAL)`);
  }
  const id = raw.slice(0, idx);
  const rawVal = raw.slice(idx + 1);
  if (rawVal === "true") return { id, value: true };
  if (rawVal === "false") return { id, value: false };
  return { id, value: rawVal };
}

/** Mirrors parseModelParam omission → undefined semantics for runtime. */
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
  // `idx <= 0` rejects both no-`=` (-1) and empty key (0) in one check.
  const idx = raw.indexOf("=");
  if (idx <= 0) {
    throw new InvalidArgumentError(`invalid --cloud-env-var: ${raw} (expected KEY=VAL)`);
  }
  return [raw.slice(0, idx), raw.slice(idx + 1)];
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

async function resolveCloudSpec(
  opts: ShipOpts,
  runtime: "local" | "cloud" | undefined,
): Promise<ShipCloud | undefined> {
  const spec = await resolveCloudSpecRaw(opts);
  // CLI is the validation boundary for direct service callers — the
  // mcp-server handler re-parses against shipInputSchema's .superRefine
  // for its callers, but the CLI bypasses that path. Without this guard
  // a missing cloud spec would surface as a runner-layer
  // MissingCloudSpecError after the workflow run row was persisted.
  if (runtime === "cloud" && spec === undefined) {
    throw new InvalidArgumentError("--runtime cloud requires --cloud-repo or --cloud <path>");
  }
  return spec;
}

async function resolveCloudSpecRaw(opts: ShipOpts): Promise<ShipCloud | undefined> {
  if (opts.cloud !== undefined) {
    return await loadCloudRunSpecFromFile(opts.cloud);
  }
  if (!hasCloudFieldFlags(opts)) {
    return undefined;
  }
  return buildCloudRunSpecFromFlags(opts);
}

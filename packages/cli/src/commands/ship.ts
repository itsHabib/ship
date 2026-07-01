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
type CliProvider = "cursor" | "claude" | "codex";
type CliRuntime = "local" | "cloud";

interface ShipOpts {
  workdir: string;
  repo: string;
  branch?: string;
  baseRef?: string;
  worktreeName?: string;
  model?: string;
  modelParam?: string[];
  json: boolean;
  provider?: string;
  runtime?: string;
  /** `--cloud` JSON file path; when set, other `--cloud-*` field flags are ignored. */
  cloud?: string;
  cloudRepo?: string;
  cloudPrBranch?: string;
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
    .option(
      "--runtime <mode>",
      "agent runtime (local|cloud); cloud supports cursor + claude; omit to use service default",
    )
    .option("--provider <name>", "agent provider (cursor|claude|codex); omit to use cursor")
    .option(
      "--cloud <path>",
      "JSON file with full CloudRunSpec (via cloudRunSpecSchema); when set, ignores --cloud-repo and other --cloud-* field flags",
    )
    .option("--cloud-repo <url>", "cloud: single repo URL (maps to cloud.repos[0].url)")
    .option(
      "--cloud-pr-branch <name>",
      "cloud: branch the agent pushes + opens a PR from (required for --provider claude --runtime cloud; ignored for cursor)",
    )
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
  const modelParams = buildModelParams(opts.modelParam);
  const provider = parseProvider(opts.provider);
  const runtime = parseRuntime(opts.runtime);
  enforceLocalOnlyProviderGuard(provider, runtime);
  const cloud = await resolveCloudSpec(opts, runtime);
  enforceClaudeCloudPrBranchGuard(provider, runtime, cloud);
  return buildShipInputFromCli(opts, docPath, { modelParams, provider, runtime, cloud });
}

// The CLI is the validation boundary for direct service callers (it bypasses the
// mcp-server's shipInputSchema.superRefine). Mirror the claude × cloud prBranch
// requirement here so omitting it surfaces a clean argument error, not a runner
// no-op that yields an empty branches[].
function enforceClaudeCloudPrBranchGuard(
  provider: CliProvider | undefined,
  runtime: CliRuntime | undefined,
  cloud: ShipCloud | undefined,
): void {
  if (provider !== "claude" || runtime !== "cloud") return;
  // Optional-chain repos[0]: this guard runs before schema validation, so a
  // malformed cloud spec missing repos[0] must surface the clean argument error
  // below, not a TypeError.
  const prBranch = cloud?.repos[0]?.prBranch;
  if (prBranch !== undefined && prBranch.length > 0) return;
  throw new InvalidArgumentError(
    "claude --runtime cloud requires --cloud-pr-branch (the branch the agent pushes)",
  );
}

function buildModelParams(
  raw: string[] | undefined,
): NonNullable<ShipInput["modelParams"]> | undefined {
  const pairs = raw ?? [];
  if (pairs.length === 0) return undefined;
  return accumulateModelParams(pairs);
}

function buildShipInputFromCli(
  opts: ShipOpts,
  docPath: string,
  parsed: {
    modelParams: NonNullable<ShipInput["modelParams"]> | undefined;
    provider: CliProvider | undefined;
    runtime: CliRuntime | undefined;
    cloud: ShipCloud | undefined;
  },
): ShipInput {
  return {
    workdir: resolvePath(opts.workdir),
    repo: opts.repo,
    docPath,
    ...(opts.branch !== undefined && { branch: opts.branch }),
    ...(opts.baseRef !== undefined && { baseRef: opts.baseRef }),
    ...(opts.worktreeName !== undefined && { worktreeName: opts.worktreeName }),
    ...(opts.model !== undefined && { model: opts.model }),
    ...(parsed.modelParams !== undefined && { modelParams: parsed.modelParams }),
    ...(parsed.provider !== undefined && { provider: parsed.provider }),
    ...(parsed.runtime !== undefined && { runtime: parsed.runtime }),
    ...(parsed.cloud !== undefined && { cloud: parsed.cloud }),
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
  // Reject empty string at parse time — the CLI bypasses shipInputSchema and
  // reaches ShipService directly, so without this guard a mistyped flag like
  // `--model-param fast=` surfaces as a downstream modelSelectionSchema
  // failure at run-time instead of an immediate argument error. Boolean
  // false is still allowed (legitimate value for composer-2.5 fast param).
  if (rawVal === "") {
    throw new InvalidArgumentError(
      `invalid --model-param: ${raw} (empty value; use KEY=true / KEY=false / KEY=<non-empty>)`,
    );
  }
  return { id, value: rawVal };
}

/** Mirrors parseModelParam omission → undefined semantics for runtime. */
function parseRuntime(raw: string | undefined): CliRuntime | undefined {
  if (raw === undefined) return undefined;
  if (raw === "local" || raw === "cloud") return raw;
  throw new InvalidArgumentError(`invalid --runtime: ${raw} (expected: local | cloud)`);
}

/** Mirrors parseRuntime omission → undefined semantics for provider. */
function parseProvider(raw: string | undefined): CliProvider | undefined {
  if (raw === undefined) return undefined;
  if (raw === "cursor" || raw === "claude" || raw === "codex") return raw;
  throw new InvalidArgumentError(`invalid --provider: ${raw} (expected: cursor | claude | codex)`);
}

// claude supports local + cloud; codex is local-only (no public cloud API).
const LOCAL_ONLY_PROVIDERS = new Set<CliProvider>(["codex"]);

function enforceLocalOnlyProviderGuard(
  provider: CliProvider | undefined,
  runtime: CliRuntime | undefined,
): void {
  if (provider === undefined || !LOCAL_ONLY_PROVIDERS.has(provider)) return;
  const effectiveRuntime = runtime ?? "local";
  if (effectiveRuntime === "cloud") {
    throw new InvalidArgumentError(`${provider} provider supports only runtime 'local'`);
  }
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
    draft["repos"] = [
      {
        url: opts.cloudRepo,
        ...(opts.cloudPrBranch !== undefined && { prBranch: opts.cloudPrBranch }),
      },
    ];
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
  runtime: CliRuntime | undefined,
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

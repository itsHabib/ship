/**
 * `ship driver <subverb>` — brain-facing driver surface (spec §6).
 */

import type { AddressOpts, Decision, DriverRunRef, LandOpts, MergeFacts } from "@ship/driver";
import type { DriverRunStatus } from "@ship/store";
import type { Command } from "commander";

import { parsePruneDuration, PruneDurationError } from "@ship/core";
import { DriverRunNotFoundEngineError } from "@ship/driver";
import { DRIVER_RUN_ID_PATTERN } from "@ship/mcp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import type { DriverServiceFactory } from "../service.js";

import { driverTickExitCode, toDriverCliExitCode } from "../driver-errors.js";
import { detectManifestDrift } from "../driver-manifest.js";
import { cliExit, InvalidArgumentError } from "../errors.js";
import {
  formatDriverDecideOutput,
  formatDriverImportOutput,
  formatDriverListOutput,
  formatDriverRunOutput,
  formatDriverStatusOutput,
} from "../format.js";

interface RunOpts {
  batch?: string;
  json?: boolean;
  maxWait?: string;
  pollInterval?: string;
  force?: boolean;
}

interface DecideOpts {
  stream: string;
  reason?: string;
  workflowRun?: string;
}

interface MarkMergedOpts {
  stream: string;
  pr: string;
  sha: string;
  mergedAt?: string;
  cycles?: string;
}

interface LandCommandOpts {
  pr: string;
  stream?: string;
  cycles?: string;
  admin?: boolean;
}

interface AddressCommandOpts {
  stream: string;
  findings: string;
  maxCycles?: string;
}

interface RenderOpts {
  out?: string;
}

interface StatusOpts {
  json?: boolean;
}

interface ListOpts {
  repo?: string;
  status?: string[];
  limit?: string;
  json?: boolean;
}

const DRIVER_RUN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "awaiting_judgment",
  "done",
  "failed",
  "cancelled",
]);

export function registerDriverCommand(program: Command, factory: DriverServiceFactory): void {
  const driver = program.command("driver").description("work-driver manifest engine");

  driver
    .command("import <manifestPath>")
    .description("import a driver.md manifest into the store")
    .action((manifestPath: string) => {
      runDriverAction(() => {
        const result = factory().importManifest(resolvePath(manifestPath));
        process.stdout.write(`${formatDriverImportOutput(result.run.id, result.warnings)}\n`);
      });
    });

  driver
    .command("run <ref>")
    .description("run one bounded engine tick (auto-imports when ref is a manifest path)")
    .option("--batch <n>", "target a single batch index")
    .option("--json", "emit DriverTickResult JSON")
    .option("--max-wait <duration>", "tick wall-clock bound (default 20m)", "20m")
    .option("--poll-interval <duration>", "poll interval between getRun scans (default 30s)", "30s")
    .option("--force", "override a live tick lease")
    .action(async (ref: string, rawOpts: RunOpts) => {
      await runDriverActionAsync(async () => {
        const driverRunRef = resolveDriverRunRef(ref);
        const maxWaitMs = parseDriverDuration(rawOpts.maxWait ?? "20m", "--max-wait");
        const pollIntervalMs = parsePositiveDriverDuration(
          rawOpts.pollInterval ?? "30s",
          "--poll-interval",
        );
        const batch =
          rawOpts.batch !== undefined
            ? parseIntOptionAtLeast(rawOpts.batch, "--batch", 1)
            : undefined;
        const result = await factory().run(driverRunRef, {
          ...(batch !== undefined ? { batch } : {}),
          force: rawOpts.force === true,
          maxWaitMs,
          pollIntervalMs,
        });
        process.stdout.write(`${formatDriverRunOutput(result, rawOpts.json === true)}\n`);
        cliExit(driverTickExitCode(result));
      });
    });

  driver
    .command("decide <driverRunId> <decision>")
    .description("apply a judgment decision to a stream (retry|skip|abort|adopt)")
    .requiredOption("--stream <ds_id>", "driver stream id")
    .option("--reason <text>", "required for skip and abort")
    .option("--workflow-run <wf_id>", "required for adopt")
    .action((driverRunId: string, decisionKind: string, rawOpts: DecideOpts) => {
      runDriverAction(() => {
        const decision = parseDecision(decisionKind, rawOpts);
        const run = factory().decide(driverRunId, rawOpts.stream, decision);
        process.stdout.write(`${formatDriverDecideOutput(run)}\n`);
      });
    });

  driver
    .command("mark-merged <driverRunId>")
    .description("record merge facts for a landed stream")
    .requiredOption("--stream <ds_id>", "driver stream id")
    .requiredOption("--pr <n>", "merged PR number")
    .requiredOption("--sha <sha>", "merge commit sha")
    .option("--merged-at <iso>", "merge timestamp (ISO-8601)")
    .option("--cycles <n>", "review cycles completed")
    .action((driverRunId: string, rawOpts: MarkMergedOpts) => {
      runDriverAction(() => {
        const facts = buildMergeFacts(rawOpts);
        const run = factory().markMerged(driverRunId, rawOpts.stream, facts);
        process.stdout.write(`${formatDriverDecideOutput(run)}\n`);
      });
    });

  driver
    .command("land <driverRunId>")
    .description("merge PR (if needed), read sha/time from gh, and record merge facts")
    .requiredOption("--pr <n>", "PR number to merge and record")
    .option("--stream <ds_id>", "driver stream id (required when prUrl is absent or ambiguous)")
    .option("--cycles <n>", "review cycles completed")
    .option("--admin", "merge with --admin (bypass branch protection)")
    .action(async (driverRunId: string, rawOpts: LandCommandOpts) => {
      await runDriverActionAsync(async () => {
        const landOpts = buildLandOpts(rawOpts);
        const run = await factory().land(driverRunId, landOpts);
        process.stdout.write(`${formatDriverDecideOutput(run)}\n`);
      });
    });

  driver
    .command("flip-cloud <driverRunId>")
    .description("flip an imported local stream to cloud, continuing its branch")
    .requiredOption("--stream <ds_id>", "driver stream id")
    .action(async (driverRunId: string, rawOpts: { stream: string }) => {
      await runDriverActionAsync(async () => {
        const run = await factory().flipStreamToCloud(driverRunId, rawOpts.stream);
        process.stdout.write(`${formatDriverDecideOutput(run)}\n`);
      });
    });

  driver
    .command("address <driverRunId>")
    .description("re-dispatch consolidated review findings onto a landed stream's PR branch")
    .requiredOption("--stream <ds_id>", "driver stream id")
    .requiredOption("--findings <path>", "path to a ReviewFindingsV1 JSON artifact")
    .option("--max-cycles <n>", "review-cycle cap (default 3)")
    .action(async (driverRunId: string, rawOpts: AddressCommandOpts) => {
      await runDriverActionAsync(async () => {
        const addressOpts = buildAddressOpts(rawOpts);
        const run = await factory().address(driverRunId, addressOpts);
        process.stdout.write(`${formatDriverDecideOutput(run)}\n`);
      });
    });

  driver
    .command("cancel <driverRunId>")
    .description("cancel an in-flight driver run")
    .action(async (driverRunId: string) => {
      await runDriverActionAsync(async () => {
        const run = await factory().cancel(driverRunId);
        process.stdout.write(`${formatDriverDecideOutput(run)}\n`);
      });
    });

  driver
    .command("render <driverRunId>")
    .description("render driver.md from store rows")
    .option("--out <path>", "write rendered manifest to path (creates parent dirs)")
    .action((driverRunId: string, rawOpts: RenderOpts) => {
      runDriverAction(() => {
        const text = factory().render(driverRunId);
        if (rawOpts.out !== undefined) {
          const outPath = resolvePath(rawOpts.out);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, text, "utf8");
          return;
        }
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      });
    });

  driver
    .command("list")
    .description("list durable driver runs (most recent first)")
    .option("--repo <name>", "filter by repo")
    .option(
      "--status <status>",
      "filter by status (repeat for multiple)",
      (value: string, prior: string[] | undefined): string[] => [...(prior ?? []), value],
    )
    .option("--limit <n>", "max rows (server cap is 200)")
    .option("--json", "emit machine-readable JSON")
    .action((rawOpts: ListOpts) => {
      runDriverAction(() => {
        const filter = buildDriverListFilter(rawOpts);
        const envelope = factory().listDriverRunsView(filter);
        process.stdout.write(`${formatDriverListOutput(envelope, rawOpts.json === true)}\n`);
      });
    });

  driver
    .command("status <driverRunId>")
    .description("show durable driver run state")
    .option("--json", "emit machine-readable JSON")
    .action((driverRunId: string, rawOpts: StatusOpts) => {
      runDriverAction(() => {
        const svc = factory();
        const run = svc.getDriverRun(driverRunId);
        if (run === null) {
          throw new DriverRunNotFoundEngineError(driverRunId);
        }
        const manifestModified = detectManifestDrift(run);
        process.stdout.write(
          `${formatDriverStatusOutput(run, manifestModified, rawOpts.json === true)}\n`,
        );
      });
    });
}

function runDriverAction(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    handleDriverError(err);
  }
}

async function runDriverActionAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    handleDriverError(err);
  }
}

function handleDriverError(err: unknown): never {
  const code = toDriverCliExitCode(err);
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  cliExit(code);
}

function resolveDriverRunRef(ref: string): DriverRunRef {
  // Full-id match, not a prefix check — a manifest path can plausibly
  // start with `drv_` (e.g. a dir named after a driver run).
  if (DRIVER_RUN_ID_PATTERN.test(ref)) {
    return { driverRunId: ref };
  }
  return { manifestPath: resolvePath(ref) };
}

/**
 * Action-time int parse (`Number`, not `parseInt`, so `10abc` rejects
 * instead of coercing) with a lower bound: batch indices and PR numbers
 * are 1-based, review-cycle counts may be zero.
 */
function parseIntOptionAtLeast(raw: string, flag: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new InvalidArgumentError(`invalid ${flag}: ${raw}`);
  }
  return n;
}

/** Like `parseDriverDuration` but rejects zero — a zero poll interval busy-loops the tick. */
function parsePositiveDriverDuration(raw: string, flag: string): number {
  const ms = parseDriverDuration(raw, flag);
  if (ms <= 0) {
    throw new InvalidArgumentError(`invalid ${flag} duration: ${raw} (must be > 0)`);
  }
  return ms;
}

/** Parses `20m`, `30s`, etc. Seconds reuse the prune duration units otherwise. */
function parseDriverDuration(raw: string, flag: string): number {
  const trimmed = raw.trim();
  const secondsMatch = /^(\d+)s$/.exec(trimmed);
  if (secondsMatch !== null) {
    const amount = Number(secondsMatch[1]);
    if (amount < 0) {
      throw new InvalidArgumentError(`invalid ${flag} duration: ${raw}`);
    }
    return amount * 1000;
  }
  try {
    return parsePruneDuration(trimmed);
  } catch (err) {
    if (err instanceof PruneDurationError) {
      throw new InvalidArgumentError(err.message.replace("--before", flag));
    }
    throw err;
  }
}

function requireDecisionReason(opts: DecideOpts, verb: "skip" | "abort"): string {
  const reason = opts.reason?.trim();
  if (reason === undefined || reason === "") {
    throw new InvalidArgumentError(`decide ${verb} requires --reason "..."`);
  }
  return reason;
}

function parseDecision(kind: string, opts: DecideOpts): Decision {
  if (kind === "retry") return { kind: "retry" };
  if (kind === "skip") return { kind: "skip", reason: requireDecisionReason(opts, "skip") };
  if (kind === "abort") return { kind: "abort", reason: requireDecisionReason(opts, "abort") };
  if (kind === "adopt") {
    const workflowRunId = opts.workflowRun?.trim();
    if (workflowRunId === undefined || workflowRunId === "") {
      throw new InvalidArgumentError("decide adopt requires --workflow-run <wf_id>");
    }
    return { kind: "adopt", workflowRunId };
  }
  throw new InvalidArgumentError(
    `invalid decision: ${kind} (expected retry | skip | abort | adopt)`,
  );
}

function buildMergeFacts(opts: MarkMergedOpts): MergeFacts {
  const facts: MergeFacts = {
    mergeCommit: opts.sha,
    prNumber: parseIntOptionAtLeast(opts.pr, "--pr", 1),
  };
  if (opts.mergedAt !== undefined) facts.mergedAt = opts.mergedAt;
  if (opts.cycles !== undefined) {
    facts.cycles = parseIntOptionAtLeast(opts.cycles, "--cycles", 0);
  }
  return facts;
}

function buildAddressOpts(opts: AddressCommandOpts): AddressOpts {
  const addressOpts: AddressOpts = {
    findingsPath: resolvePath(opts.findings),
    streamId: opts.stream,
  };
  if (opts.maxCycles !== undefined) {
    addressOpts.maxCycles = parseIntOptionAtLeast(opts.maxCycles, "--max-cycles", 1);
  }
  return addressOpts;
}

function buildLandOpts(opts: LandCommandOpts): LandOpts {
  const landOpts: LandOpts = {
    prNumber: parseIntOptionAtLeast(opts.pr, "--pr", 1),
  };
  if (opts.stream !== undefined) landOpts.streamId = opts.stream;
  if (opts.cycles !== undefined) {
    landOpts.cycles = parseIntOptionAtLeast(opts.cycles, "--cycles", 0);
  }
  if (opts.admin === true) landOpts.admin = true;
  return landOpts;
}

function buildDriverListFilter(opts: ListOpts): {
  repo?: string;
  status?: DriverRunStatus[];
  limit?: number;
} {
  const filter: {
    repo?: string;
    status?: DriverRunStatus[];
    limit?: number;
  } = {};
  if (opts.repo !== undefined) filter.repo = opts.repo;
  if (opts.status !== undefined && opts.status.length > 0) {
    for (const status of opts.status) {
      if (!DRIVER_RUN_STATUSES.has(status)) {
        throw new InvalidArgumentError(`invalid --status: ${status}`);
      }
    }
    filter.status = opts.status as DriverRunStatus[];
  }
  if (opts.limit !== undefined) {
    const parsed = Number(opts.limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`invalid --limit: ${opts.limit}`);
    }
    filter.limit = parsed;
  }
  return filter;
}

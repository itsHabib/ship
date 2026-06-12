/**
 * `ship driver <subverb>` — brain-facing driver surface (spec §6).
 */

import type { Decision, DriverRunRef, MergeFacts } from "@ship/driver";
import type { Command } from "commander";

import { parsePruneDuration, PruneDurationError } from "@ship/core";
import {
  CancelError,
  DecideError,
  DriverRunNotFoundEngineError,
  ImportManifestError,
  PreconditionError,
  TickLiveError,
} from "@ship/driver";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import type { DriverServiceFactory } from "../service.js";

import { driverTickExitCode, toDriverCliExitCode } from "../driver-errors.js";
import { detectManifestDrift } from "../driver-manifest.js";
import { cliExit, InvalidArgumentError } from "../errors.js";
import {
  formatDriverDecideOutput,
  formatDriverImportOutput,
  formatDriverRunOutput,
  formatDriverStatusOutput,
} from "../format.js";

interface RunOpts {
  batch?: number;
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
  pr: number;
  sha: string;
  mergedAt?: string;
  cycles?: number;
}

interface RenderOpts {
  out?: string;
}

interface StatusOpts {
  json?: boolean;
}

export function registerDriverCommand(program: Command, factory: DriverServiceFactory): void {
  const driver = program.command("driver").description("work-driver manifest engine");

  driver
    .command("import <manifestPath>")
    .description("import a driver.md manifest into the store")
    .action((manifestPath: string) => {
      runDriverAction(() => {
        const result = factory().importManifest(resolvePath(manifestPath));
        process.stdout.write(`${formatDriverImportOutput(result.run.id)}\n`);
      });
    });

  driver
    .command("run <ref>")
    .description("run one bounded engine tick (auto-imports when ref is a manifest path)")
    .option("--batch <n>", "target a single batch index", parseIntOption)
    .option("--json", "emit DriverTickResult JSON")
    .option("--max-wait <duration>", "tick wall-clock bound (default 20m)", "20m")
    .option("--poll-interval <duration>", "poll interval between getRun scans (default 30s)", "30s")
    .option("--force", "override a live tick lease")
    .action(async (ref: string, rawOpts: RunOpts) => {
      await runDriverActionAsync(async () => {
        const driverRunRef = resolveDriverRunRef(ref);
        const maxWaitMs = parseDriverDuration(rawOpts.maxWait ?? "20m", "--max-wait");
        const pollIntervalMs = parseDriverDuration(
          rawOpts.pollInterval ?? "30s",
          "--poll-interval",
        );
        const result = await factory().run(driverRunRef, {
          ...(rawOpts.batch !== undefined ? { batch: rawOpts.batch } : {}),
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
    .requiredOption("--pr <n>", "merged PR number", parseIntOption)
    .requiredOption("--sha <sha>", "merge commit sha")
    .option("--merged-at <iso>", "merge timestamp (ISO-8601)")
    .option("--cycles <n>", "review cycles completed", parseIntOption)
    .action((driverRunId: string, rawOpts: MarkMergedOpts) => {
      runDriverAction(() => {
        const facts = buildMergeFacts(rawOpts);
        const run = factory().markMerged(driverRunId, rawOpts.stream, facts);
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
        const drift = detectManifestDrift(run);
        process.stdout.write(`${formatDriverStatusOutput(run, drift, rawOpts.json === true)}\n`);
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
  if (err instanceof InvalidArgumentError || isDriverCliEngineError(err)) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    cliExit(1);
  }
  const code = toDriverCliExitCode(err);
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  cliExit(code);
}

function isDriverCliEngineError(err: unknown): err is Error {
  return (
    err instanceof TickLiveError ||
    err instanceof PreconditionError ||
    err instanceof DecideError ||
    err instanceof CancelError ||
    err instanceof DriverRunNotFoundEngineError ||
    err instanceof ImportManifestError
  );
}

function resolveDriverRunRef(ref: string): DriverRunRef {
  if (ref.startsWith("drv_")) {
    return { driverRunId: ref };
  }
  return { manifestPath: resolvePath(ref) };
}

function parseIntOption(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new InvalidArgumentError(`invalid integer: ${raw}`);
  }
  return n;
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
    prNumber: opts.pr,
  };
  if (opts.mergedAt !== undefined) facts.mergedAt = opts.mergedAt;
  if (opts.cycles !== undefined) facts.cycles = opts.cycles;
  return facts;
}

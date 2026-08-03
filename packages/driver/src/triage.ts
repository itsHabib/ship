/**
 * Triage-floor classifier — the mechanism that sizes a PR's review risk.
 *
 * The driver shells out `gh pr diff <n> -R <owner>/<name> | triage-floor`: the
 * unified diff on stdin, a `T0`–`T3` tier line on stdout, exit 0 = classified /
 * non-zero = operational failure. This module owns that shell-out and its
 * failure handling; the engine keys re-classification on the PR head SHA and
 * persists the outcome on the driver stream (see engine.ts `classifyLandedStreamTriage`).
 *
 * "tier" here is the review-risk tier — deliberately distinct from the
 * model/effort dispatch tiers in tier-map.ts. Same word, two concepts; this
 * one never touches which model dispatches, only how much review a PR needs.
 *
 * A classifier failure (missing binary, non-zero exit, timeout, unparseable
 * output) is its own outcome — never a fabricated tier.
 */

import type { TriageTier } from "@ship/store";

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type { TriageTier };

/** A classified tier, or a structured operational failure — never both. */
export type TriageOutcome =
  | {
      kind: "classified";
      tier: TriageTier;
      reasons?: string[];
      signals?: TriageSignal[];
      files?: number;
      added?: number;
      removed?: number;
    }
  | { kind: "error"; reason: string };

export interface TriageSignal {
  signal: string;
  tier: TriageTier;
  why: string;
}

export interface TriageClassifier {
  /**
   * Classify the PR at `repoSlug` (the full `owner/name` slug, e.g.
   * `itsHabib/ship` — never the bare store label) / `prNumber`. Resolves to an
   * outcome; the classifier never throws (every failure is `{ kind: "error" }`).
   */
  classify(repoSlug: string, prNumber: number): Promise<TriageOutcome>;
}

/** Terminal result of running `triage-floor` over a diff. */
export interface TriageFloorResult {
  stdout: string;
  /** Process exit code; `null` when terminated by signal. */
  code: number | null;
}

/**
 * Injectable I/O seam — the two shell-outs behind the pipe. Unit tests replace
 * either side; production uses the `node:child_process` adapters below.
 */
export interface TriageExec {
  /** stdout of `gh pr diff <n> -R <slug>` (the unified diff fed to stdin). */
  diff(repoSlug: string, prNumber: number): Promise<string>;
  /** Run `triage-floor` with `diff` on stdin; resolve stdout + exit code. */
  triageFloor(diff: string, repoSlug: string): Promise<TriageFloorResult>;
}

const DEFAULT_TRIAGE_TIMEOUT_MS = 60_000;
// gh pr diff can be large; cap generously so a real PR diff isn't truncated
// into an unparseable classification.
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_DETAIL = 200;

const TIER_TOKEN = /^T[0-3]$/;

interface TriageFloorJson {
  floor: unknown;
  signals: unknown;
  files: unknown;
  added: unknown;
  removed: unknown;
}

/**
 * Parse current `triage-floor` JSON into a tier. Bare legacy tier lines are
 * incomplete evidence and therefore fail closed.
 */
export function parseTriageTier(stdout: string): TriageTier | undefined {
  return parseTriageResult(stdout)?.tier;
}

export function parseTriageResult(
  stdout: string,
): Extract<TriageOutcome, { kind: "classified" }> | undefined {
  return parseTriageJson(stdout);
}

export interface CreateTriageClassifierOpts {
  /** Override either shell-out (both default to the child_process adapters). */
  exec?: Partial<TriageExec>;
  /** Per-shell-out timeout. Default 60s. */
  timeoutMs?: number;
  /** Binary name for the classifier. Default `triage-floor`. */
  triageFloorBin?: string;
  /** Binary name for the GitHub CLI. Default `gh`. */
  ghBin?: string;
}

/**
 * Build a classifier over the `gh pr diff | triage-floor` pipe. Every failure
 * mode — gh error, missing `triage-floor`, non-zero exit, timeout, unparseable
 * output — resolves to `{ kind: "error" }`; the classifier never rejects.
 */
export function createExecTriageClassifier(
  opts: CreateTriageClassifierOpts = {},
): TriageClassifier {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TRIAGE_TIMEOUT_MS;
  const ghBin = opts.ghBin ?? "gh";
  const triageFloorBin = opts.triageFloorBin ?? "triage-floor";
  const exec: TriageExec = {
    diff: opts.exec?.diff ?? ((slug, pr) => defaultDiff(ghBin, slug, pr, timeoutMs)),
    triageFloor:
      opts.exec?.triageFloor ??
      ((diff, slug) => defaultTriageFloor(triageFloorBin, diff, slug, timeoutMs)),
  };
  return { classify: (slug, pr) => classifyWith(exec, slug, pr) };
}

async function classifyWith(
  exec: TriageExec,
  repoSlug: string,
  prNumber: number,
): Promise<TriageOutcome> {
  let diff: string;
  try {
    diff = await exec.diff(repoSlug, prNumber);
  } catch (err: unknown) {
    return { kind: "error", reason: `gh pr diff failed: ${errorDetail(err)}` };
  }
  let result: TriageFloorResult;
  try {
    result = await exec.triageFloor(diff, repoSlug);
  } catch (err: unknown) {
    return { kind: "error", reason: `triage-floor failed: ${errorDetail(err)}` };
  }
  if (result.code !== 0) {
    return { kind: "error", reason: `triage-floor exited ${String(result.code)}` };
  }
  const classification = parseTriageResult(result.stdout);
  if (classification === undefined) {
    return {
      kind: "error",
      reason: `triage-floor produced unparseable output: ${truncate(result.stdout)}`,
    };
  }
  return classification;
}

async function defaultDiff(
  ghBin: string,
  repoSlug: string,
  prNumber: number,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFileAsync(ghBin, ["pr", "diff", String(prNumber), "-R", repoSlug], {
    maxBuffer: MAX_DIFF_BYTES,
    timeout: timeoutMs,
  });
  return stdout;
}

function defaultTriageFloor(
  bin: string,
  diff: string,
  repoSlug: string,
  timeoutMs: number,
): Promise<TriageFloorResult> {
  return spawnWithStdin(bin, ["-repo", repoSlug], diff, timeoutMs);
}

function parseTriageJson(
  stdout: string,
): Extract<TriageOutcome, { kind: "classified" }> | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(decoded)) return undefined;
  const value = decoded as unknown as TriageFloorJson;
  if (typeof value.floor !== "string" || !TIER_TOKEN.test(value.floor)) return undefined;
  if (!Array.isArray(value.signals)) return undefined;
  if (!isNonNegativeInteger(value.files)) return undefined;
  if (!isNonNegativeInteger(value.added)) return undefined;
  if (!isNonNegativeInteger(value.removed)) return undefined;
  const signals = value.signals.map(parseSignal);
  if (signals.some((signal) => signal === undefined)) return undefined;
  const parsedSignals = signals as TriageSignal[];
  return {
    added: value.added,
    files: value.files,
    kind: "classified",
    reasons: parsedSignals.map((signal) => signal.why),
    removed: value.removed,
    signals: parsedSignals,
    tier: value.floor as TriageTier,
  };
}

function parseSignal(value: unknown): TriageSignal | undefined {
  if (!isRecord(value)) return undefined;
  const signal = value["signal"];
  const tier = value["tier"];
  const why = value["why"];
  if (typeof signal !== "string" || signal === "") return undefined;
  if (typeof tier !== "string" || !TIER_TOKEN.test(tier)) return undefined;
  if (typeof why !== "string" || why === "") return undefined;
  return { signal, tier: tier as TriageTier, why };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Spawn `bin args` with `input` on stdin; resolve stdout + exit code. Rejects on
 * spawn error (missing binary → ENOENT), broken-pipe stdin error, or timeout.
 * No shell — the binary and args are passed directly.
 *
 * @internal exported for tests.
 */
export function spawnWithStdin(
  bin: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
): Promise<TriageFloorResult> {
  return new Promise((resolve, reject) => {
    // Fixed classifier binary; input travels on stdin, no shell (shell: false).
    const child = spawn(bin, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    // Drain stderr so a chatty classifier can't fill the pipe and stall.
    child.stderr.on("data", () => undefined);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    // Missing binary lands here (ENOENT) — a classifier error, not a crash.
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    // A binary that exits before reading input breaks the pipe (EPIPE); treat
    // it as a spawn failure rather than an uncaught stream error.
    child.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`stdin error: ${err.message}`));
    });
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      // The 'error' handlers above have already rejected; nothing to add.
    }
  });
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_ERROR_DETAIL) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_DETAIL)}…`;
}

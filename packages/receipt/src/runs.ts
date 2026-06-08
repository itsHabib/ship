/**
 * Adapter: a ship run directory → a ship-run receipt.
 *
 * Each terminal ship run persists `<runs-dir>/<runId>/result.json`
 * (`{ status, durationMs, model.id, branches[] }`). This module maps one
 * such record to a receipt (the EXECUTION detail: terminal status, duration,
 * model, and a PR link when a cloud run opened one).
 *
 * `runResultToReceipt` is pure (parsed JSON + injected timestamps in, receipt
 * out); `loadShipRunReceipts` is the thin filesystem wrapper around it.
 */

import type { Stats } from "node:fs";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import type { Receipt, ReceiptOutcome } from "./schema.js";

import { buildReceipt } from "./schema.js";

const resultSchema = z
  .object({
    status: z.string().optional(),
    durationMs: z.number().optional(),
    model: z.object({ id: z.string().optional() }).passthrough().optional(),
    branches: z.array(z.object({ prUrl: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

interface RunInput {
  runId: string;
  result: unknown;
  dispatchedAt: string | undefined;
  terminalAt: string | undefined;
}

/** Map a parsed `result.json` to a ship-run receipt, or null if unparseable. */
export function runResultToReceipt(input: RunInput): Receipt | null {
  const parsed = resultSchema.safeParse(input.result);
  if (!parsed.success) {
    return null;
  }

  const result = parsed.data;
  const prUrl = firstPrUrl(result.branches);
  const raw: Record<string, unknown> = {
    key: input.runId,
    source: "ship-run",
    outcome: runOutcome(result.status),
    run_id: input.runId,
    ship_status: result.status,
    duration_ms:
      result.durationMs === undefined ? undefined : Math.max(0, Math.round(result.durationMs)),
    model: result.model?.id,
    pr_url: prUrl,
    pr_number: prNumberFromUrl(prUrl),
    cost_tokens: null,
    dispatched_at: input.dispatchedAt,
    terminal_at: input.terminalAt,
  };
  // Isolate per-run: a single result that fails schema validation (e.g. a
  // malformed PR URL) yields null and is skipped — it never aborts the load.
  return tryBuild(raw);
}

function tryBuild(raw: Record<string, unknown>): Receipt | null {
  try {
    return buildReceipt(raw);
  } catch {
    return null;
  }
}

/** Read every `<runs-dir>/<runId>/result.json` into ship-run receipts. */
export function loadShipRunReceipts(runsDir: string): Receipt[] {
  const receipts: Receipt[] = [];
  for (const runId of listRunDirs(runsDir)) {
    const receipt = loadOneRun(runsDir, runId);
    if (receipt !== null) {
      receipts.push(receipt);
    }
  }
  return receipts;
}

/**
 * Resolve the default ship runs dir: `SHIP_RUNS_DIR` override, else
 * `<XDG_CONFIG_HOME | APPDATA | ~/.config>/ship/runs`. Mirrors the resolution
 * the ship CLI / MCP entrypoints use.
 */
export function resolveDefaultRunsDir(
  env: NodeJS.ProcessEnv,
  platform: string,
  home: string,
): string {
  const override = env["SHIP_RUNS_DIR"];
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(configHome(env, platform, home), "ship", "runs");
}

function configHome(env: NodeJS.ProcessEnv, platform: string, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  // Match the ship CLI: only an ABSOLUTE XDG_CONFIG_HOME is honored; a relative
  // value falls through to the platform default rather than scanning cwd-relative.
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) {
    return xdg;
  }
  if (platform === "win32") {
    return env["APPDATA"] ?? join(home, "AppData", "Roaming");
  }
  return join(home, ".config");
}

function loadOneRun(runsDir: string, runId: string): Receipt | null {
  const dir = join(runsDir, runId);
  const resultPath = join(dir, "result.json");
  const raw = readJson(resultPath);
  if (raw === null) {
    return null;
  }
  return runResultToReceipt({
    runId,
    result: raw,
    // The run dir is created at dispatch (birthtime); result.json is written at
    // terminal (mtime). Using the dir's mtime for dispatch would read ~terminal,
    // since writing result.json bumps the dir's mtime.
    dispatchedAt: plausibleDispatch(statIso(dir, (stats) => stats.birthtime)),
    terminalAt: statIso(resultPath, (stats) => stats.mtime),
  });
}

function listRunDirs(runsDir: string): string[] {
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function statIso(path: string, pick: (stats: Stats) => Date): string | undefined {
  try {
    return pick(statSync(path)).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * `birthtime` is unreliable on filesystems that don't track creation time (some
 * Linux mounts), where it reads back as the epoch. Drop a degenerate pre-2000
 * value rather than persist a bogus 1970 dispatch. (We deliberately do NOT drop
 * birthtime≈mtime — a genuinely fast run has them nearly equal.)
 */
export function plausibleDispatch(iso: string | undefined): string | undefined {
  if (iso === undefined) {
    return undefined;
  }
  return iso < "2000-01-01" ? undefined : iso;
}

function runOutcome(status: string | undefined): ReceiptOutcome {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "unknown";
}

function firstPrUrl(branches: { prUrl?: string | undefined }[] | undefined): string | undefined {
  if (branches === undefined) {
    return undefined;
  }
  for (const branch of branches) {
    if (branch.prUrl !== undefined && branch.prUrl !== "") {
      return branch.prUrl;
    }
  }
  return undefined;
}

function prNumberFromUrl(prUrl: string | undefined): number | undefined {
  if (prUrl === undefined) {
    return undefined;
  }
  const match = /\/pull\/(\d+)/.exec(prUrl);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1], 10);
  return parsed > 0 ? parsed : undefined;
}

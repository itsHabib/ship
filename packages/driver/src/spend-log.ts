/**
 * Append-only review-spend telemetry — one JSONL line per event in a fresh
 * `review-spend.jsonl` beside the ship store's `state.db`. Best-effort: a write
 * failure warns and returns, never throwing, so it can never block a land.
 *
 * Engine scope is the terminal merge fact plus the Workbench review decision
 * consumed by `driver address`. Per-bot cost data and fixes-PR linkage remain
 * where `/work-driver` processes raw PR comments.
 */

import type { Logger } from "@ship/logger";
import type { TriageTier, TriageTierSource } from "@ship/store";

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** A landed (or closed) PR's terminal spend record. */
export interface TerminalSpendEvent {
  ts: string;
  event: "terminal";
  repo: string;
  pr: number;
  /** Absent when the head was never classified (e.g. classifier_error). */
  tier?: TriageTier;
  tier_source?: TriageTierSource;
  cycles_used?: number;
  merged: boolean;
  /** Prior PR this one declares it fixes; recorded by the skill, not the engine. */
  fixes_pr?: number | null;
}

/** One exact-head Workbench decision consumed by Ship's address adapter. */
export interface ReviewDecisionSpendEvent {
  ts: string;
  event: "review_decision";
  repo: string;
  pr: number;
  head_sha: string;
  plan_id: string;
  input_digest: string;
  policy_id?: string;
  policy_digest?: string;
  route_disposition:
    | "tier_routed"
    | "deliberately_overridden"
    | "full_panel_fallback"
    | "parked_unverified";
  route_reason?: string;
  tier?: TriageTier;
  tier_reasons: string[];
  cycle: number;
  continuation_weight: number;
  cumulative_weight: number;
  decision_action: "address";
  decision_reasons: string[];
  reviewers_requested: string[];
  reviewers_completed: string[];
  next_reviewers: string[];
  findings_by_severity: Record<string, number>;
  findings_by_disposition: Record<string, number>;
}

export type SpendEvent = ReviewDecisionSpendEvent | TerminalSpendEvent;

export interface AppendSpendOpts {
  /** Override the log path (tests inject a temp path). */
  path?: string;
  /** Warn sink for a best-effort write failure. */
  logger?: Logger;
}

/**
 * `review-spend.jsonl` in ship's state dir — beside `state.db`, honoring
 * `SHIP_DB_PATH`, else `<userConfigDir>/ship/`. Mirrors the store's path
 * convention; a little copying beats a driver→cli dependency.
 */
export function resolveSpendLogPath(): string {
  const dbOverride = process.env["SHIP_DB_PATH"];
  // Honor the override only when absolute — the store ignores a relative
  // SHIP_DB_PATH and uses the default config-dir db, so a relative one here
  // would strand spend events beside a db the run never touched.
  if (dbOverride !== undefined && isAbsolute(dbOverride)) {
    return join(dirname(dbOverride), "review-spend.jsonl");
  }
  return join(userConfigDir(), "ship", "review-spend.jsonl");
}

/**
 * The spend-log path for a store opened at `dbPath` — its sibling
 * `review-spend.jsonl`, so the log lands beside the exact `state.db` the run
 * writes (not a re-resolved default). Undefined for an in-memory or empty
 * store, which has no on-disk sibling; the caller then skips the append.
 */
export function spendLogPathForDb(dbPath: string): string | undefined {
  if (dbPath === ":memory:" || dbPath === "") return undefined;
  return join(dirname(dbPath), "review-spend.jsonl");
}

function userConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData !== undefined && isAbsolute(appData)) return appData;
    return join(homedir(), "AppData", "Roaming");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && isAbsolute(xdg)) return xdg;
  return join(homedir(), ".config");
}

/**
 * Owner/name slug from a GitHub repo URL (e.g. `https://github.com/o/r` → `o/r`),
 * for the spend record's join key. Undefined when the URL isn't parseable.
 */
export function ownerNameFromRepoUrl(url: string): string | undefined {
  // Name may contain dots (e.g. `service.api`); strip only a trailing `.git`.
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+)/u.exec(url);
  const owner = match?.[1];
  const name = match?.[2]?.replace(/\.git$/u, "");
  if (owner === undefined || name === undefined || name === "") return undefined;
  return `${owner}/${name}`;
}

/**
 * Append one event as a JSONL line. Best-effort: on any failure it warns (when
 * a logger is given) and returns — never throws, so a land is never blocked.
 */
export function appendSpendEvent(event: SpendEvent, opts?: AppendSpendOpts): void {
  const path = opts?.path ?? resolveSpendLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  } catch (err: unknown) {
    opts?.logger?.warn({ err: String(err), path }, "review-spend: append failed (best-effort)");
  }
}

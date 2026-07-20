/**
 * Dispatch-fallback hop policy (spec §4.2–§4.7, §7.2) — eligibility, the
 * no-work-products gate, transient-blip retry, in-memory chain walk, and
 * FALLBACK_RESET_PATCH.
 *
 * Mechanism stays dumb: callers (engine seams) supply stream + deps; this module
 * decides retry / hop / exhaust / ineligible and builds the one atomic store patch.
 */

import type {
  DriverStream,
  FallbackChainTarget,
  FallbackLogRecord,
  StreamAttempt,
  UpdateDriverStreamInput,
} from "@ship/store";
import type { AgentProvider, FailureCategory } from "@ship/workflow";

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { EffortTier, ModelTier } from "./manifest.js";

import { cellStructuralIssue } from "./dispatch-cell.js";
import { mapTierToDispatch } from "./tier-map.js";
import { checkTargetViability, type DispatchTarget, type ViabilityDeps } from "./viability.js";

/** Same default as `DEFAULT_DISPATCH_PROVIDER` in engine.ts — kept local to avoid a cycle. */
const IMPLICIT_DISPATCH_PROVIDER: AgentProvider = "cursor";

/** Spec §4.2 allowlist — sync `sdk-throw` + async pre-work gateway failures. */
export const FALLBACK_ELIGIBLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  "sdk-throw",
  "gateway-unreachable",
  "gateway-auth",
]);

/**
 * Spec §4.7 transient-shape allowlist — connect-timeout / transient-network /
 * rate-limit class, classifiable from the error text in hand. There is no
 * persisted `isRetryable` signal in packages/ today.
 */
const TRANSIENT_NETWORK_RE =
  /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i;
const TRANSIENT_CONNECT_TIMEOUT_RE = /connect(?:ion)?[- ]?timeout|connect(?:ion)? timed out/i;
const TRANSIENT_RATE_LIMIT_RE = /\b429\b|rate[- _]?limit(?:ed)?/i;

/** Columns PENDING_RESET_PATCH clears (judgment.ts) — shared with hop reset. */
const PENDING_RESET_COLUMNS = {
  dispatchModel: null,
  dispatchModelParams: null,
  dispatchProvider: null,
  effortDegraded: false,
  status: "pending" as const,
  tierDegradeReason: null,
};

export function isFallbackEligibleCategory(category: FailureCategory): boolean {
  return FALLBACK_ELIGIBLE_CATEGORIES.has(category);
}

/** True when the error text matches a known transient shape (§4.7). */
export function matchesTransientErrorShape(errorMessage: string): boolean {
  if (TRANSIENT_NETWORK_RE.test(errorMessage)) return true;
  if (TRANSIENT_CONNECT_TIMEOUT_RE.test(errorMessage)) return true;
  return TRANSIENT_RATE_LIMIT_RE.test(errorMessage);
}

/**
 * §4.7 sensor: transient shape OR the inherently-transient `contention`
 * category (non-hop; must still reach the one same-target retry).
 */
export function isTransientBlipFailure(errorMessage: string, category?: FailureCategory): boolean {
  if (category === "contention") return true;
  return matchesTransientErrorShape(errorMessage);
}

/** True when `fallbackLog` already records a §4.7 retry for the current target. */
export function hasCurrentTargetBeenRetried(stream: DriverStream): boolean {
  const current = currentTarget(stream);
  for (const record of stream.fallbackLog ?? []) {
    if (!("retried" in record)) continue;
    if (sameCell(record.retried, current)) return true;
  }
  return false;
}

/**
 * Unused §4.7 retry on the current target for a transient-shaped last failure —
 * the stream is still movement-capable without consuming the chain.
 */
export function hasUnusedTransientRetry(stream: DriverStream): boolean {
  if (!hasNoWorkProducts(stream)) return false;
  if (hasCurrentTargetBeenRetried(stream)) return false;
  const category = stream.attempts.at(-1)?.failureCategory as FailureCategory | undefined;
  return isTransientBlipFailure(stream.errorMessage ?? "", category);
}

/**
 * Spec §4.3 no-work-products gate. Pre-work ⇔ reviewCycles coalesce to 0 AND
 * no genuine PR. A failed flip and cloud autoPR both persist `prUrl` at
 * reviewCycles 0 — either blocks the hop. `pollPrUrl` covers the autoPR case
 * where the workflow already has a PR before the stream column is written.
 */
export function hasNoWorkProducts(stream: DriverStream, pollPrUrl?: string): boolean {
  if ((stream.reviewCycles ?? 0) !== 0) return false;
  if (stream.prUrl !== undefined) return false;
  if (pollPrUrl !== undefined && pollPrUrl !== "") return false;
  return true;
}

/** True while the chain still has untried entries (breaker must not park). */
export function hasUnconsumedFallbackChain(stream: DriverStream): boolean {
  const chain = stream.fallbackChain;
  if (chain === undefined || chain.length === 0) return false;
  const cursor = stream.fallbackCursor ?? 0;
  return cursor < chain.length;
}

/**
 * Could a future failure of the same shape still move the stream (retry or
 * hop)? An unused §4.7 retry on a transient failure keeps the stream
 * movement-capable; an ineligible category or a work-carrying stream never
 * hops, so its live chain must not suppress the #199 breaker forever.
 */
export function chainStillConsumable(stream: DriverStream): boolean {
  if (!hasNoWorkProducts(stream)) return false;
  if (hasUnusedTransientRetry(stream)) return true;
  // Attempt rows persist the category as a plain string; an unrecognized value
  // is simply not in the allowlist.
  const category = stream.attempts.at(-1)?.failureCategory;
  if (category === undefined) return true;
  return (FALLBACK_ELIGIBLE_CATEGORIES as ReadonlySet<string>).has(category);
}

/**
 * True when a declared non-empty chain has been fully consumed — §6 escalation
 * subsumes the #199 breaker copy for these streams.
 */
export function hasExhaustedFallbackChain(stream: DriverStream): boolean {
  const chain = stream.fallbackChain;
  if (chain === undefined || chain.length === 0) return false;
  const cursor = stream.fallbackCursor ?? 0;
  return cursor >= chain.length;
}

export type FallbackHopDecision =
  | { kind: "ineligible" }
  | {
      kind: "retry";
      patch: UpdateDriverStreamInput;
    }
  | {
      kind: "hop";
      patch: UpdateDriverStreamInput;
    }
  | {
      kind: "exhaust";
      patch: UpdateDriverStreamInput;
    };

export interface FallbackHopContext {
  category: FailureCategory;
  /** Failed attempts already marked terminal for this failure. */
  failedAttempts: StreamAttempt[];
  repoRoot: string;
  repoUrl: string | undefined;
  /** ISO timestamp for hop/skip records. */
  at: string;
  viability: ViabilityDeps;
  /** Poll-seam PR URL from the workflow run, if any. */
  pollPrUrl?: string;
}

export interface TransientRetryContext {
  category: FailureCategory;
  errorMessage: string;
  failedAttempts: StreamAttempt[];
  at: string;
  pollPrUrl?: string;
}

/**
 * Spec §4.7 — one same-target re-dispatch for a transient blip. Checked FIRST,
 * independent of the §4.2 category allowlist (so `contention` still retries).
 * Returns undefined when the retry does not apply.
 */
export function decideTransientRetry(
  stream: DriverStream,
  ctx: TransientRetryContext,
): Extract<FallbackHopDecision, { kind: "retry" }> | undefined {
  if (!isTransientBlipFailure(ctx.errorMessage, ctx.category)) return undefined;
  if (!hasNoWorkProducts(stream, ctx.pollPrUrl)) return undefined;
  if (hasCurrentTargetBeenRetried(stream)) return undefined;

  const target = currentTarget(stream);
  const log: FallbackLogRecord[] = [
    ...(stream.fallbackLog ?? []),
    { retried: target, reason: ctx.category, at: ctx.at },
  ];
  return {
    kind: "retry",
    patch: {
      ...PENDING_RESET_COLUMNS,
      attempts: ctx.failedAttempts,
      fallbackLog: log,
    },
  };
}

/**
 * Decide hop / exhaust / ineligible for a terminal pre-work failure. Callers
 * apply the returned patch in one `updateDriverStream` (with the failed
 * attempts). Does not write. Call `decideTransientRetry` first (§4.7).
 */
export async function decideFallbackHop(
  stream: DriverStream,
  ctx: FallbackHopContext,
): Promise<FallbackHopDecision> {
  if (!isFallbackEligibleCategory(ctx.category)) return { kind: "ineligible" };
  if (!hasNoWorkProducts(stream, ctx.pollPrUrl)) return { kind: "ineligible" };

  const chain = stream.fallbackChain;
  if (chain === undefined || chain.length === 0) return { kind: "ineligible" };

  const startCursor = stream.fallbackCursor ?? 0;
  if (startCursor >= chain.length) return { kind: "ineligible" };

  let walk: WalkHop | WalkExhaust;
  try {
    walk = await walkFallbackChain(stream, chain, startCursor, ctx);
  } catch {
    // Viability UNKNOWN (e.g. a transient cursor-catalog outage) is not a
    // skip — a skip burns the entry permanently. Park without consuming; a
    // later `decide retry` re-walks once the catalog answers again.
    return { kind: "ineligible" };
  }
  if (walk.kind === "hop") {
    return {
      kind: "hop",
      patch: buildFallbackResetPatch({
        failedAttempts: ctx.failedAttempts,
        from: currentTarget(stream),
        to: walk.target,
        category: ctx.category,
        cursor: walk.cursor,
        log: walk.log,
        at: ctx.at,
        stream,
      }),
    };
  }

  return {
    kind: "exhaust",
    patch: {
      attempts: ctx.failedAttempts,
      fallbackCursor: walk.cursor,
      fallbackLog: walk.log,
      status: "failed",
    },
  };
}

interface WalkHop {
  kind: "hop";
  target: FallbackChainTarget;
  cursor: number;
  log: FallbackLogRecord[];
}

interface WalkExhaust {
  kind: "exhaust";
  cursor: number;
  log: FallbackLogRecord[];
}

async function walkFallbackChain(
  stream: DriverStream,
  chain: FallbackChainTarget[],
  startCursor: number,
  ctx: FallbackHopContext,
): Promise<WalkHop | WalkExhaust> {
  const log: FallbackLogRecord[] = [...(stream.fallbackLog ?? [])];
  let cursor = startCursor;

  while (cursor < chain.length) {
    const entry = chain[cursor];
    if (entry === undefined) break;
    const nextCursor = cursor + 1;
    const skipReason = await skipReasonForTarget(entry, stream, ctx);
    if (skipReason !== undefined) {
      log.push({ skipped: entry, reason: skipReason, at: ctx.at });
      cursor = nextCursor;
      continue;
    }
    return { kind: "hop", target: entry, cursor: nextCursor, log };
  }

  return { kind: "exhaust", cursor, log };
}

async function skipReasonForTarget(
  entry: FallbackChainTarget,
  stream: DriverStream,
  ctx: FallbackHopContext,
): Promise<string | undefined> {
  const structural = cellStructuralIssue(
    { provider: entry.provider, runtime: entry.runtime },
    { branchName: stream.branch, repoUrl: ctx.repoUrl },
  );
  if (structural === "unwired-cell") {
    return `unwired cell ${entry.runtime}/${entry.provider}`;
  }
  if (structural === "needs-branch") {
    return `${entry.runtime}/${entry.provider} needs branch_name`;
  }
  if (structural === "needs-repo-url") {
    return `${entry.runtime}/${entry.provider} needs repo_url`;
  }

  const worktreeReason = localWorktreeSkipReason(entry, stream, ctx.repoRoot);
  if (worktreeReason !== undefined) return worktreeReason;

  return viabilitySkipReason(entry, ctx.viability);
}

function localWorktreeSkipReason(
  entry: FallbackChainTarget,
  stream: DriverStream,
  repoRoot: string,
): string | undefined {
  if (entry.runtime !== "local") return undefined;
  if (stream.branch === undefined) return undefined;
  const worktreePath = join(repoRoot, ".claude", "worktrees", stream.branch);
  if (existsSync(worktreePath)) return undefined;
  return `local worktree missing: ${worktreePath}`;
}

async function viabilitySkipReason(
  entry: FallbackChainTarget,
  viability: ViabilityDeps,
): Promise<string | undefined> {
  // Cursor credential first, before any catalog lookup: a MISSING key is a
  // definitive skip with a remedy — it must never surface as the catalog
  // call's throw (UNKNOWN), which parks instead of skipping. Without a
  // concrete model_id the credential gate is the whole check — tier mapping
  // stands at dispatch (model attribution is P2b). Claude/codex ignore
  // modelId inside checkTargetViability.
  if (entry.provider === "cursor") {
    const key = viability.env["CURSOR_API_KEY"];
    if (key === undefined || key.trim() === "") return "CURSOR_API_KEY not set";
    if (entry.modelId === undefined) return undefined;
  }

  const target: DispatchTarget = {
    modelId: entry.modelId ?? "",
    provider: entry.provider,
    runtime: entry.runtime,
  };
  // A thrown viability check means UNKNOWN, not unviable — propagate so the
  // walk aborts without consuming the entry (decideFallbackHop parks instead).
  const result = await checkTargetViability(target, viability);
  if (result.viable) return undefined;
  return result.reason;
}

function currentTarget(stream: DriverStream): FallbackChainTarget {
  const provider: AgentProvider = stream.provider ?? IMPLICIT_DISPATCH_PROVIDER;
  const target: FallbackChainTarget = {
    provider,
    runtime: stream.runtime,
  };
  if (stream.modelId !== undefined) target.modelId = stream.modelId;
  return target;
}

/**
 * Resolved dispatch model for a (provider, tiers, modelId) triple — what
 * `dispatchModel` was / will be after `mapTierToDispatch`.
 */
export function resolveDispatchModel(
  provider: AgentProvider,
  modelTier?: ModelTier,
  effortTier?: EffortTier,
  modelId?: string,
): string | undefined {
  return mapTierToDispatch(provider, modelTier, effortTier, modelId).model;
}

function resolveFromModel(stream: DriverStream): string | undefined {
  if (stream.dispatchModel !== undefined) return stream.dispatchModel;
  return resolveDispatchModel(
    stream.provider ?? IMPLICIT_DISPATCH_PROVIDER,
    stream.modelTier,
    stream.effortTier,
    stream.modelId,
  );
}

function resolveToModel(stream: DriverStream, to: FallbackChainTarget): string | undefined {
  return resolveDispatchModel(to.provider, stream.modelTier, stream.effortTier, to.modelId);
}

function buildFallbackResetPatch(params: {
  failedAttempts: StreamAttempt[];
  from: FallbackChainTarget;
  to: FallbackChainTarget;
  category: FailureCategory;
  cursor: number;
  log: FallbackLogRecord[];
  at: string;
  stream: DriverStream;
}): UpdateDriverStreamInput {
  const fromModel = resolveFromModel(params.stream);
  const toModel = resolveToModel(params.stream, params.to);
  const hopRecord: FallbackLogRecord = {
    from: params.from,
    to: params.to,
    category: params.category,
    at: params.at,
    ...(fromModel !== undefined ? { fromModel } : {}),
    ...(toModel !== undefined ? { toModel } : {}),
  };
  const log = [...params.log, hopRecord];

  return {
    ...PENDING_RESET_COLUMNS,
    attempts: withResetBoundary(params.failedAttempts),
    fallbackCursor: params.cursor,
    fallbackLog: log,
    // The target is the full (runtime, provider, model_id) triple — a stale
    // primary model id must not ride onto a different target's dispatch.
    modelId: params.to.modelId ?? null,
    provider: params.to.provider,
    runtime: params.to.runtime,
    workOnCurrentBranch: false,
  };
}

/** Stamp the latest attempt so the #199 breaker window restarts on the new target. */
function withResetBoundary(attempts: StreamAttempt[]): StreamAttempt[] {
  const last = attempts.at(-1);
  if (last === undefined) return attempts;
  return [...attempts.slice(0, -1), { ...last, resetBoundary: true }];
}

/**
 * Spec §6 exhaustion escalation copy. Terminal `failed:` line is derived from
 * the attempt category + current runtime/provider — not from fallbackLog.
 */
export function buildFallbackExhaustionEscalationCopy(
  stream: DriverStream,
  terminalCategory: FailureCategory,
): { subject: string; body: string } {
  const chain = stream.fallbackChain ?? [];
  const n = chain.length;
  const label = stream.taskSlug ?? stream.specPath;
  const subject = `dispatch failed after fallback: ${label} exhausted ${String(n)}-target chain`;

  const lines: string[] = [formatPrimaryOutcome(stream, terminalCategory)];
  for (const record of stream.fallbackLog ?? []) {
    lines.push(formatLogOutcome(record));
  }

  const current = `${stream.runtime}/${stream.provider ?? IMPLICIT_DISPATCH_PROVIDER}`;
  lines.push(`failed: ${terminalCategory} on ${current}`);
  lines.push(`bare decide retry re-fires ${current}`);

  return { subject, body: lines.join("\n") };
}

function formatPrimaryOutcome(stream: DriverStream, terminalCategory: FailureCategory): string {
  const log = stream.fallbackLog ?? [];
  const firstHop = log.find(
    (r): r is Extract<FallbackLogRecord, { from: FallbackChainTarget }> => "from" in r,
  );
  if (firstHop !== undefined) {
    const cell = formatCell(firstHop.from);
    const retried = log.some((r) => "retried" in r && sameCell(r.retried, firstHop.from));
    const suffix = retried ? " (retried once)" : "";
    return `primary ${cell}: ${firstHop.category}${suffix}`;
  }
  // Exhaustion with only skips (or empty log) — primary is still current columns
  // when nothing hopped; after hops, current is last target and primary came from
  // the hop's `from`. No hop + skips only → primary never changed.
  const cell = formatCell(currentTarget(stream));
  return `primary ${cell}: ${terminalCategory}`;
}

function formatLogOutcome(record: FallbackLogRecord): string {
  if ("from" in record) {
    return `hopped ${formatCell(record.from)} → ${formatCell(record.to)} on ${record.category}`;
  }
  if ("skipped" in record) {
    const remedy = remedyForSkipReason(record.reason);
    const base = `skipped ${formatCell(record.skipped)}: ${record.reason}`;
    return remedy === undefined ? base : `${base} — remedy: ${remedy}`;
  }
  return `retried ${formatCell(record.retried)} once on ${record.reason}`;
}

function formatCell(target: FallbackChainTarget): string {
  const cell = `${target.runtime}/${target.provider}`;
  return target.modelId === undefined ? cell : `${cell}:${target.modelId}`;
}

function sameCell(a: FallbackChainTarget, b: FallbackChainTarget): boolean {
  return a.runtime === b.runtime && a.provider === b.provider && a.modelId === b.modelId;
}

/** Credential-shaped skip reasons → actionable remedy line for §6. */
function remedyForSkipReason(reason: string): string | undefined {
  const match = /([A-Z][A-Z0-9_]+(?:, [A-Z][A-Z0-9_]+)*(?:,? or [A-Z][A-Z0-9_]+)?)/.exec(reason);
  if (match?.[1] === undefined) return undefined;
  if (!reason.includes("not set") && !reason.includes("needs")) return undefined;
  return `set ${match[1]}`;
}

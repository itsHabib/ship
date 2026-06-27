/**
 * `land` — merge (if needed), read sha/time from gh, record via markMerged.
 */

import type { RepoMergeGrant, Store } from "@ship/store";
import type { DriverRun, DriverStream } from "@ship/store";

import { prNumberFromUrl } from "@ship/receipt";

import type { DriverGhPort, GhPrReadiness, GhPullRequestView } from "./gh-port.js";
import type { LandOpts, MergeFacts, MergeVerdict } from "./types.js";

import { DecideError } from "./errors.js";
import { toGhRepo } from "./gh-port.js";
import { allStreams, extractRepoUrl, markMerged } from "./judgment.js";
import { buildMergeVerdictInputs } from "./merge-verdict-inputs.js";
import { assembleMergeVerdict } from "./merge-verdict.js";

// Post-merge view poll — GitHub can lag briefly after mergePullRequest.
const POST_MERGE_VIEW_ATTEMPTS = 3;
const POST_MERGE_VIEW_DELAY_MS = 200;

type SleepFn = (ms: number) => Promise<void>;

interface GrantSatisfactionPlan {
  grant: RepoMergeGrant;
  verdict: MergeVerdict;
}

interface GrantPlanContext {
  gh: DriverGhPort;
  initialView: GhPullRequestView;
  normalizedRepo: string;
  opts: LandOpts;
  store: Store;
  stream: DriverStream;
}

interface FetchMergedPrViewOpts {
  initialView?: GhPullRequestView;
  sleep?: SleepFn;
}

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function land(
  store: Store,
  gh: DriverGhPort,
  driverRunId: string,
  opts: LandOpts,
): Promise<DriverRun> {
  const run = loadRun(store, driverRunId);
  const repo = resolveRepoForGh(run);
  const streamId = resolveLandStream(run, opts, repo);
  assertStreamLandable(run, streamId);
  const stream = findStream(run, streamId);
  if (stream === undefined) {
    throw new DecideError(`stream not found: ${streamId}`);
  }

  const normalizedRepo = toGhRepo(repo);
  const initialView = await gh.viewPullRequest(repo, opts.prNumber);
  const satisfactionPlan = await resolveGrantSatisfactionPlan({
    gh,
    initialView,
    normalizedRepo,
    opts,
    store,
    stream,
  });
  const useAdmin = resolveAdminFlag(opts, satisfactionPlan);
  const prView = await fetchMergedPrView(gh, repo, opts.prNumber, useAdmin, { initialView });
  const facts = buildLandFacts(prView, opts);
  const mergedRun = markMerged(store, driverRunId, streamId, facts);
  if (
    satisfactionPlan !== undefined &&
    store.getMergeGrantSatisfaction(normalizedRepo, opts.prNumber) === null
  ) {
    store.recordMergeGrantSatisfaction({
      driverRunId,
      driverStreamId: streamId,
      grantId: satisfactionPlan.grant.id,
      mergeCommit: facts.mergeCommit,
      prNumber: opts.prNumber,
      repo: normalizedRepo,
      verdictJson: JSON.stringify(satisfactionPlan.verdict),
    });
  }
  return mergedRun;
}

function findStream(run: DriverRun, streamId: string): DriverStream | undefined {
  return allStreams(run).find((stream) => stream.id === streamId);
}

function resolveAdminFlag(opts: LandOpts, plan: GrantSatisfactionPlan | undefined): boolean {
  if (opts.admin === true) return true;
  if (opts.admin === false) return false;
  if (plan === undefined) return false;
  return plan.verdict.outcome === "merge_authorized";
}

async function resolveGrantSatisfactionPlan(
  ctx: GrantPlanContext,
): Promise<GrantSatisfactionPlan | undefined> {
  if (ctx.opts.admin === true || ctx.opts.admin === false) return undefined;
  if (ctx.initialView.state === "MERGED") return undefined;
  if (ctx.store.getMergeGrantSatisfaction(ctx.normalizedRepo, ctx.opts.prNumber) !== null) {
    return undefined;
  }
  const grant = ctx.store.getActiveRepoMergeGrant(ctx.normalizedRepo);
  if (grant === null) return undefined;

  const verdict =
    ctx.opts.mergeVerdict ??
    (await assembleVerdictFromGh(ctx.gh, ctx.normalizedRepo, ctx.opts.prNumber, ctx.stream));
  if (verdict.outcome !== "merge_authorized") return undefined;
  return { grant, verdict };
}

async function assembleVerdictFromGh(
  gh: DriverGhPort,
  repo: string,
  prNumber: number,
  stream: DriverStream,
): Promise<MergeVerdict> {
  const context = await gh.fetchPrMergeGateContext(repo, prNumber);
  const inputs = buildMergeVerdictInputs({
    checks: context.checks,
    headSha: context.headSha,
    reviews: context.reviews,
    ...(stream.cycles !== undefined ? { streamCycles: stream.cycles } : {}),
  });
  return assembleMergeVerdict(inputs);
}

function loadRun(store: Store, driverRunId: string): DriverRun {
  const run = store.getDriverRun(driverRunId);
  if (run === null) {
    throw new DecideError(`driver run not found: ${driverRunId}`);
  }
  return run;
}

function resolveRepoForGh(run: DriverRun): string {
  const repo = extractRepoUrl(run);
  if (repo === undefined || repo === "") {
    throw new DecideError("cannot resolve repo URL for gh operations");
  }
  return repo;
}

function assertStreamLandable(run: DriverRun, streamId: string): void {
  const stream = allStreams(run).find((s) => s.id === streamId);
  if (stream === undefined) {
    throw new DecideError(`stream not found: ${streamId}`);
  }
  if (stream.status !== "landed" && stream.status !== "done") {
    throw new DecideError(
      `stream ${streamId} is not in a landable state (expected landed or done; got ${stream.status})`,
    );
  }
}

async function fetchMergedPrView(
  gh: DriverGhPort,
  repo: string,
  prNumber: number,
  admin: boolean,
  viewOpts: FetchMergedPrViewOpts = {},
): Promise<GhPullRequestView> {
  const sleep = viewOpts.sleep ?? defaultSleep;
  try {
    let prView = viewOpts.initialView ?? (await gh.viewPullRequest(repo, prNumber));
    if (prView.state !== "MERGED") {
      await assertReady(gh, repo, prNumber);
      await gh.mergePullRequest(repo, prNumber, { admin });
      prView = await readMergedViewWithRetry(gh, repo, prNumber, { sleep });
    }

    return validateMergedPrView(prView, prNumber);
  } catch (err) {
    if (err instanceof DecideError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new DecideError(`gh operation failed for PR #${String(prNumber)}: ${detail}`);
  }
}

function validateMergedPrView(prView: GhPullRequestView, prNumber: number): GhPullRequestView {
  if (prView.state !== "MERGED") {
    throw new DecideError(`PR #${String(prNumber)} is not merged (state=${prView.state})`);
  }
  const mergeOid = prView.mergeCommit?.oid;
  if (mergeOid === undefined || mergeOid === "") {
    throw new DecideError(`PR #${String(prNumber)} has no merge commit`);
  }
  return prView;
}

interface PostMergeViewRetryOpts {
  sleep: SleepFn;
  attempts?: number;
  delayMs?: number;
}

async function readMergedViewWithRetry(
  gh: DriverGhPort,
  repo: string,
  prNumber: number,
  retry: PostMergeViewRetryOpts,
): Promise<GhPullRequestView> {
  const attempts = retry.attempts ?? POST_MERGE_VIEW_ATTEMPTS;
  const delayMs = retry.delayMs ?? POST_MERGE_VIEW_DELAY_MS;
  let prView = await gh.viewPullRequest(repo, prNumber);
  for (let attempt = 1; attempt < attempts && prView.state !== "MERGED"; attempt++) {
    await retry.sleep(delayMs);
    prView = await gh.viewPullRequest(repo, prNumber);
  }
  return prView;
}

/** Conclusions that count as a passing terminal check. */
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Readiness guard — refuse to merge a PR that is not genuinely ready. Always
 * on (no flag, no --force in v1). Gates on isDraft + mergeable(conflicts) +
 * the CHECKS rollup ONLY — deliberately NOT on the overall mergeStateStatus,
 * which reads BLOCKED for the bots-only-comment workflow (missing required
 * approval) that --admin intentionally bypasses.
 */
async function assertReady(gh: DriverGhPort, repo: string, prNumber: number): Promise<void> {
  const readiness = await gh.fetchPrReadiness(repo, prNumber);
  const reason = unreadyReason(readiness);
  if (reason !== undefined) {
    throw new DecideError(`refusing to merge PR #${String(prNumber)}: not ready — ${reason}`);
  }
}

function unreadyReason(readiness: GhPrReadiness): string | undefined {
  if (readiness.isDraft) {
    return "draft";
  }
  if (readiness.mergeable === "CONFLICTING") {
    return "merge conflicts";
  }
  const failing = readiness.checks.filter(isFailingCheck).map((c) => c.name);
  if (failing.length > 0) {
    return `failing checks: ${failing.join(", ")}`;
  }
  const running = readiness.checks.filter(isNonTerminalCheck).map((c) => c.name);
  if (running.length > 0) {
    return `checks still running: ${running.join(", ")}`;
  }
  return undefined;
}

function isTerminalCheck(check: { status: string; conclusion: string }): boolean {
  return check.status === "COMPLETED" && check.conclusion !== "";
}

function isNonTerminalCheck(check: { status: string; conclusion: string }): boolean {
  return !isTerminalCheck(check);
}

function isFailingCheck(check: { status: string; conclusion: string }): boolean {
  return isTerminalCheck(check) && !PASSING_CONCLUSIONS.has(check.conclusion);
}

function buildLandFacts(prView: GhPullRequestView, opts: LandOpts): MergeFacts {
  const mergeOid = prView.mergeCommit?.oid;
  if (mergeOid === undefined || mergeOid === "") {
    throw new DecideError(`PR #${String(opts.prNumber)} has no merge commit`);
  }

  const facts: MergeFacts = {
    mergeCommit: mergeOid,
    prNumber: opts.prNumber,
  };
  if (prView.mergedAt !== undefined && prView.mergedAt !== null) {
    facts.mergedAt = prView.mergedAt;
  }
  if (opts.cycles !== undefined) {
    facts.cycles = opts.cycles;
  }
  return facts;
}

function resolveLandStream(run: DriverRun, opts: LandOpts, runRepo: string): string {
  if (opts.streamId !== undefined) {
    return resolveExplicitStream(run, opts.streamId, opts.prNumber);
  }
  return resolveStreamByPr(run, opts.prNumber, runRepo);
}

function resolveExplicitStream(run: DriverRun, streamId: string, prNumber: number): string {
  const stream = allStreams(run).find((s) => s.id === streamId);
  if (stream === undefined) {
    throw new DecideError(`stream not found: ${streamId}`);
  }
  const urlPr = prNumberFromUrl(stream.prUrl);
  if (urlPr !== undefined && urlPr !== prNumber) {
    throw new DecideError(
      `stream ${streamId} prUrl resolves to PR #${String(urlPr)}, not #${String(prNumber)}`,
    );
  }
  return streamId;
}

function repoSlugFromPrUrl(prUrl: string | undefined): string | undefined {
  if (prUrl === undefined) {
    return undefined;
  }
  const match = /github\.com[/:]([^/]+\/[^/]+)\/pull\/\d+/i.exec(prUrl);
  return match?.[1];
}

function streamMatchesRunRepo(stream: DriverStream, runRepo: string): boolean {
  const streamRepo = repoSlugFromPrUrl(stream.prUrl);
  if (streamRepo === undefined) {
    return false;
  }
  return streamRepo.toLowerCase() === runRepo.toLowerCase();
}

function resolveStreamByPr(run: DriverRun, prNumber: number, runRepo: string): string {
  const normalizedRunRepo = toGhRepo(runRepo);
  const matches = allStreams(run).filter(
    (stream): stream is DriverStream & { status: "done" | "landed" } =>
      (stream.status === "landed" || stream.status === "done") &&
      prNumberFromUrl(stream.prUrl) === prNumber &&
      streamMatchesRunRepo(stream, normalizedRunRepo),
  );

  if (matches.length === 0) {
    throw new DecideError(
      `no landed stream matches PR #${String(prNumber)}; pass --stream when prUrl is absent or ambiguous`,
    );
  }
  if (matches.length > 1) {
    throw new DecideError(
      `multiple landed streams match PR #${String(prNumber)}; pass --stream to disambiguate`,
    );
  }

  const match = matches[0];
  if (match === undefined) {
    throw new DecideError(`no landed stream matches PR #${String(prNumber)}`);
  }
  return match.id;
}

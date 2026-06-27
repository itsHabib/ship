/**
 * `land` — merge (if needed), read sha/time from gh, record via markMerged.
 */

import type { Store } from "@ship/store";
import type { DriverRun, DriverStream } from "@ship/store";

import { prNumberFromUrl } from "@ship/receipt";

import type { DriverGhPort, GhPrReadiness, GhPullRequestView } from "./gh-port.js";
import type { LandOpts, MergeFacts, MergeVerdict } from "./types.js";

import { DecideError } from "./errors.js";
import { toGhRepo } from "./gh-port.js";
import { allStreams, extractRepoUrl, markMerged } from "./judgment.js";
import { assembleMergeVerdictFromGh } from "./merge-verdict-from-gh.js";

// Post-merge view poll — GitHub can lag briefly after mergePullRequest.
const POST_MERGE_VIEW_ATTEMPTS = 3;
const POST_MERGE_VIEW_DELAY_MS = 200;

type SleepFn = (ms: number) => Promise<void>;

interface PostMergeViewRetryOpts {
  sleep: SleepFn;
  attempts?: number;
  delayMs?: number;
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

  const { admin, authorizingVerdict, grantId } = await resolveAdminMerge(
    store,
    gh,
    repo,
    stream,
    opts,
  );
  const prView = await fetchMergedPrView(gh, repo, opts.prNumber, admin);
  const facts = buildLandFacts(prView, opts);
  const mergedRun = markMerged(store, driverRunId, streamId, facts);

  if (grantId !== undefined && authorizingVerdict !== undefined) {
    store.recordMergeGrantSatisfaction({
      driverRunId,
      driverStreamId: streamId,
      grantId,
      mergeCommit: facts.mergeCommit,
      prNumber: opts.prNumber,
      verdictJson: JSON.stringify(authorizingVerdict),
    });
  }

  return mergedRun;
}

interface ResolvedAdminMerge {
  admin: boolean;
  authorizingVerdict?: MergeVerdict;
  grantId?: string;
}

async function resolveAdminMerge(
  store: Store,
  gh: DriverGhPort,
  repo: string,
  stream: DriverStream,
  opts: LandOpts,
): Promise<ResolvedAdminMerge> {
  if (opts.admin === true) {
    return { admin: true };
  }

  const grant = store.getActiveMergeGrant(repo);
  if (grant === null) {
    return { admin: false };
  }

  const verdict = await resolveMergeVerdict(gh, repo, stream, opts);
  if (verdict.outcome !== "merge_authorized") {
    return { admin: false };
  }

  return {
    admin: true,
    authorizingVerdict: verdict,
    grantId: grant.id,
  };
}

async function resolveMergeVerdict(
  gh: DriverGhPort,
  repo: string,
  stream: DriverStream,
  opts: LandOpts,
): Promise<MergeVerdict> {
  if (opts.verdict !== undefined) {
    return opts.verdict;
  }
  const gateFacts = await gh.fetchPrMergeGateFacts(repo, opts.prNumber);
  return assembleMergeVerdictFromGh({
    ciSha: gateFacts.ciSha,
    readiness: gateFacts.readiness,
    reviewCoordinatorCycles: stream.cycles ?? opts.cycles ?? 0,
    reviews: gateFacts.reviews,
  });
}

function findStream(run: DriverRun, streamId: string): DriverStream | undefined {
  return allStreams(run).find((candidate) => candidate.id === streamId);
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
  sleep: SleepFn = defaultSleep,
): Promise<GhPullRequestView> {
  try {
    let prView = await gh.viewPullRequest(repo, prNumber);
    if (prView.state !== "MERGED") {
      // Always-on readiness guard: refuse to merge an unready PR. Runs even
      // under --admin (admin bypasses the *approval* gate, not this check).
      await assertReady(gh, repo, prNumber);
      await gh.mergePullRequest(repo, prNumber, { admin });
      prView = await readMergedViewWithRetry(gh, repo, prNumber, { sleep });
    }

    if (prView.state !== "MERGED") {
      throw new DecideError(`PR #${String(prNumber)} is not merged (state=${prView.state})`);
    }

    const mergeOid = prView.mergeCommit?.oid;
    if (mergeOid === undefined || mergeOid === "") {
      throw new DecideError(`PR #${String(prNumber)} has no merge commit`);
    }

    return prView;
  } catch (err) {
    if (err instanceof DecideError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new DecideError(`gh operation failed for PR #${String(prNumber)}: ${detail}`);
  }
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

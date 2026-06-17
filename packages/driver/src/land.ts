/**
 * `land` — merge (if needed), read sha/time from gh, record via markMerged.
 */

import type { Store } from "@ship/store";
import type { DriverRun, DriverStream } from "@ship/store";

import { prNumberFromUrl } from "@ship/receipt";

import type { DriverGhPort, GhPullRequestView } from "./gh-port.js";
import type { LandOpts, MergeFacts } from "./types.js";

import { DecideError } from "./errors.js";
import { allStreams, extractRepoUrl, markMerged } from "./judgment.js";

export async function land(
  store: Store,
  gh: DriverGhPort,
  driverRunId: string,
  opts: LandOpts,
): Promise<DriverRun> {
  const run = loadRun(store, driverRunId);
  const repo = resolveRepoForGh(run);
  const streamId = resolveLandStream(run, opts);
  assertStreamLandable(run, streamId);

  const prView = await fetchMergedPrView(gh, repo, opts.prNumber);
  const facts = buildLandFacts(prView, opts);
  return markMerged(store, driverRunId, streamId, facts);
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
    throw new DecideError(`stream ${streamId} is not landed (status=${stream.status})`);
  }
}

async function fetchMergedPrView(
  gh: DriverGhPort,
  repo: string,
  prNumber: number,
): Promise<GhPullRequestView> {
  try {
    let prView = await gh.viewPullRequest(repo, prNumber);
    if (prView.state !== "MERGED") {
      await gh.mergePullRequest(repo, prNumber);
      prView = await gh.viewPullRequest(repo, prNumber);
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

function resolveLandStream(run: DriverRun, opts: LandOpts): string {
  if (opts.streamId !== undefined) {
    return resolveExplicitStream(run, opts.streamId, opts.prNumber);
  }
  return resolveStreamByPr(run, opts.prNumber);
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

function resolveStreamByPr(run: DriverRun, prNumber: number): string {
  const matches = allStreams(run).filter(
    (stream): stream is DriverStream & { status: "landed" } =>
      stream.status === "landed" && prNumberFromUrl(stream.prUrl) === prNumber,
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

// `OpenPrService` — pushes a workflow run's branch and opens a PR
// via the `GhClient` (Octokit) + `GitRemote` (git CLI) interfaces.
// State machine per docs/features/ship-v2/phases/02-open-pr.md § ED-2;
// cancel wiring via the shared `activeRuns` registry per § ED-8.
//
// Type/schema layering (§ ED-3): the input/output type definitions
// below are the source of truth; `@ship/mcp` defines
// `openPrInputSchema` / `openPrOutputSchema` whose `z.infer` must
// match these shapes. The drift assertion lives here (where the
// existing core → mcp dep arrow naturally flows) rather than in mcp/
// (which would invert it).

import type { OpenPrInput as McpOpenPrInput, OpenPrOutput as McpOpenPrOutput } from "@ship/mcp";
import type { Store } from "@ship/store";
import type { PhaseOpenPrResult } from "@ship/workflow";

import { WorkflowRunNotFoundError } from "@ship/store";
import { newPhaseId } from "@ship/workflow";

import type { ShipFs } from "./fs/shape.js";
import type { GhClient } from "./gh.js";
import type { GitRemote } from "./git-remote.js";
import type { ActiveRunsRegistry } from "./service.js";

import {
  BaseBranchUnresolvedError,
  EmptyBranchError,
  ImplementPhaseNotSucceededError,
  OpenPrAbortedError,
  OriginRepoUnresolvedError,
  WorkdirNotGitError,
  WorkflowRunStillActiveError,
} from "./errors.js";

// Hand-written input shape (the source-of-truth contract). The drift
// assertion below pins that `z.infer<openPrInputSchema>` in `@ship/mcp`
// stays bidirectionally compatible with this — if the schema or this
// type diverge, `_inputMatches`'s assignment fails to typecheck.
// `string | undefined` (not bare `string`) for optional fields matches
// what `z.infer` produces under `exactOptionalPropertyTypes: true` —
// the property may be omitted, OR present-but-undefined; both are
// load-bearing for the caller-flexibility contract.
export interface OpenPrInput {
  workflowRunId: string;
  base?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  draft?: boolean | undefined;
}

// Hand-written output shape — what `OpenPrService.openPr` returns and
// what the MCP boundary serializes. `status` is narrowed to the
// terminal literal so a future impl that accidentally returns a
// different value fails Zod validation at the boundary.
export interface OpenPrOutput {
  workflowRunId: string;
  phaseId: string;
  prNumber: number;
  prUrl: string;
  base: string;
  head: string;
  alreadyExisted: boolean;
  status: "succeeded";
}

// Drift assertions: each `_*Matches` const fails to compile if the
// inferred schema shape and the hand-written shape diverge in either
// direction. The check lives in core (where `core → mcp` already
// flows) rather than in mcp (which would invert the dep arrow per
// ED-3's literal placement but require adding `@ship/core` as a
// devDependency of `@ship/mcp` and tripping a workspace cycle).
type _InputMatches = McpOpenPrInput extends OpenPrInput
  ? OpenPrInput extends McpOpenPrInput
    ? true
    : false
  : false;
type _OutputMatches = McpOpenPrOutput extends OpenPrOutput
  ? OpenPrOutput extends McpOpenPrOutput
    ? true
    : false
  : false;
const _inputMatches: _InputMatches = true;
const _outputMatches: _OutputMatches = true;

export interface OpenPrService {
  openPr(input: OpenPrInput): Promise<OpenPrOutput>;
}

export interface OpenPrServiceDeps {
  readonly store: Store;
  readonly fs: ShipFs;
  readonly clock: () => string;
  readonly gh: GhClient;
  readonly git: GitRemote;
  // Shared with `ShipService` so `cancelRun` can signal whichever
  // service holds the controller. Default: a fresh map (single-service
  // wiring; production wiring passes the shared one).
  readonly activeRuns?: ActiveRunsRegistry;
  readonly ids?: { phase: () => string };
}

export function createOpenPrService(deps: OpenPrServiceDeps): OpenPrService {
  const activeRuns: ActiveRunsRegistry = deps.activeRuns ?? (new Map() as ActiveRunsRegistry);
  const ids = deps.ids ?? { phase: newPhaseId };
  return {
    openPr: (input) =>
      openPr({
        input,
        store: deps.store,
        fs: deps.fs,
        clock: deps.clock,
        gh: deps.gh,
        git: deps.git,
        activeRuns,
        ids,
      }),
  };
}

interface OpenPrCtx {
  readonly input: OpenPrInput;
  readonly store: Store;
  readonly fs: ShipFs;
  readonly clock: () => string;
  readonly gh: GhClient;
  readonly git: GitRemote;
  readonly activeRuns: ActiveRunsRegistry;
  readonly ids: { phase: () => string };
}

async function openPr(ctx: OpenPrCtx): Promise<OpenPrOutput> {
  const controller = new AbortController();
  registerController(ctx, controller);
  try {
    const prep = await resolvePrep(ctx);
    throwIfAborted(controller, ctx.input.workflowRunId);
    const phaseId = persistInitialPhase(ctx, prep);
    return await driveOpenPrPhase(ctx, prep, phaseId, controller);
  } finally {
    ctx.activeRuns.delete(ctx.input.workflowRunId);
  }
}

function registerController(ctx: OpenPrCtx, controller: AbortController): void {
  if (ctx.activeRuns.has(ctx.input.workflowRunId)) {
    throw new WorkflowRunStillActiveError(ctx.input.workflowRunId);
  }
  ctx.activeRuns.set(ctx.input.workflowRunId, { controller });
}

function throwIfAborted(controller: AbortController, workflowRunId: string): void {
  if (controller.signal.aborted) {
    throw new OpenPrAbortedError(workflowRunId);
  }
}

interface PreparedOpenPr {
  readonly head: string;
  readonly base: string;
  readonly workdir: string;
  readonly docPath: string;
  readonly owner: string;
  readonly repo: string;
  readonly subjects: string[];
  readonly existingPr: { number: number; url: string } | null;
}

async function resolvePrep(ctx: OpenPrCtx): Promise<PreparedOpenPr> {
  // Step 1: lookup + state-machine preconditions (no DB writes yet —
  // a failure here leaves the system unchanged).
  const run = ctx.store.getRun(ctx.input.workflowRunId);
  if (run === null) {
    throw new WorkflowRunNotFoundError(ctx.input.workflowRunId);
  }

  assertImplementPhaseSucceeded(run);
  await assertWorkdirIsGit(ctx.fs, run.worktree.path);

  const origin = await ctx.git.readOriginRepo({ workdir: run.worktree.path });
  if (origin === null) {
    // `git remote get-url origin` itself failed — no remote, not a repo.
    throw new OriginRepoUnresolvedError(run.worktree.path);
  }
  if (origin.slug === null) {
    // We got a URL back, but couldn't parse it. Surface the URL so
    // the operator sees exactly what failed (e.g. a GitLab remote, a
    // bare path, a typo).
    throw new OriginRepoUnresolvedError(run.worktree.path, `origin url: ${origin.rawUrl}`);
  }
  const slug = origin.slug;

  const head = await resolveHead(ctx, run.worktree);
  const base = await resolveBase(ctx, run.worktree.path, head);
  const existingPr = await probeExistingPr(ctx, slug, head, base);
  // Idempotency probe runs BEFORE the empty-branch check (§ F5 +
  // Validation §). A cherry-picked-into-base branch that still has
  // an open PR must resolve via the existing-PR path, not throw
  // EmptyBranchError.
  const subjects = existingPr
    ? []
    : await ctx.git.listCommitSubjects({ workdir: run.worktree.path, head, base });
  if (existingPr === null && subjects.length === 0) {
    throw new EmptyBranchError(head, base);
  }
  return {
    head,
    base,
    workdir: run.worktree.path,
    docPath: run.docPath,
    owner: slug.owner,
    repo: slug.repo,
    subjects,
    existingPr,
  };
}

function assertImplementPhaseSucceeded(run: {
  id: string;
  phases: readonly { kind: string; status: string }[];
}): void {
  const implement = run.phases.find((p) => p.kind === "implement");
  if (implement?.status !== "succeeded") {
    throw new ImplementPhaseNotSucceededError(run.id, implement?.status ?? "missing");
  }
}

async function assertWorkdirIsGit(fs: ShipFs, workdir: string): Promise<void> {
  try {
    await fs.stat(`${workdir}/.git`);
  } catch {
    throw new WorkdirNotGitError(workdir);
  }
}

async function resolveHead(
  ctx: OpenPrCtx,
  worktree: { branch: string; path: string },
): Promise<string> {
  if (worktree.branch !== "" && worktree.branch !== "(unknown)") return worktree.branch;
  const current = await ctx.git.readCurrentBranch({ workdir: worktree.path });
  if (current === null || current === "") {
    throw new EmptyBranchError("(unknown)", ctx.input.base ?? "(unknown)");
  }
  return current;
}

async function resolveBase(ctx: OpenPrCtx, workdir: string, head: string): Promise<string> {
  if (ctx.input.base !== undefined) return ctx.input.base;
  const fromConfig = await ctx.git.readConfig({
    workdir,
    key: `branch.${head}.gh-merge-base`,
  });
  if (fromConfig !== null) return fromConfig;
  try {
    return await ctx.git.readDefaultBranch({ workdir });
  } catch (err) {
    // Chain the original error (typically `OriginHeadUnsetError`,
    // which carries the `git remote set-head origin -a` remediation
    // hint) so the operator sees the actionable root cause via
    // `err.cause` instead of losing it to the wrapper.
    throw new BaseBranchUnresolvedError(workdir, head, { cause: err });
  }
}

async function probeExistingPr(
  ctx: OpenPrCtx,
  slug: { owner: string; repo: string },
  head: string,
  base: string,
): Promise<{ number: number; url: string } | null> {
  const prs = await ctx.gh.listOpenPrsForBranch({
    owner: slug.owner,
    repo: slug.repo,
    head,
    base,
  });
  const first = prs[0];
  if (first === undefined) return null;
  return { number: first.number, url: first.url };
}

function persistInitialPhase(ctx: OpenPrCtx, prep: PreparedOpenPr): string {
  const phaseId = ctx.ids.phase();
  ctx.store.appendPhase({
    id: phaseId,
    workflowRunId: ctx.input.workflowRunId,
    kind: "open_pr",
    inputJson: JSON.stringify({
      base: prep.base,
      head: prep.head,
      draft: ctx.input.draft ?? false,
    }),
  });
  // pending → running transition. Can't reuse the atomic
  // `markRunStarted` (which also flips the workflow row) — the
  // workflow is already `succeeded` from the implement phase, and
  // re-transitioning it would violate the state machine.
  ctx.store.updatePhase(phaseId, { status: "running", startedAt: ctx.clock() });
  return phaseId;
}

async function driveOpenPrPhase(
  ctx: OpenPrCtx,
  prep: PreparedOpenPr,
  phaseId: string,
  controller: AbortController,
): Promise<OpenPrOutput> {
  try {
    if (prep.existingPr !== null) {
      return finalizeSucceeded(ctx, prep, phaseId, prep.existingPr, true);
    }
    await ctx.git.pushBranch({ workdir: prep.workdir, branch: prep.head });
    throwIfAborted(controller, ctx.input.workflowRunId);
    const title = await deriveTitle(ctx, prep);
    const body = deriveBody(ctx, prep);
    const created = await ctx.gh.createPr({
      owner: prep.owner,
      repo: prep.repo,
      base: prep.base,
      head: prep.head,
      title,
      body,
      draft: ctx.input.draft ?? false,
    });
    return finalizeSucceeded(ctx, prep, phaseId, created, false);
  } catch (err) {
    finalizeFailure(ctx, prep, phaseId, err);
    throw err;
  }
}

function finalizeSucceeded(
  ctx: OpenPrCtx,
  prep: PreparedOpenPr,
  phaseId: string,
  pr: { number: number; url: string },
  alreadyExisted: boolean,
): OpenPrOutput {
  const result: PhaseOpenPrResult = {
    prNumber: pr.number,
    prUrl: pr.url,
    base: prep.base,
    head: prep.head,
    alreadyExisted,
  };
  ctx.store.updatePhase(phaseId, {
    status: "succeeded",
    endedAt: ctx.clock(),
    outputJson: JSON.stringify(result),
  });
  return {
    workflowRunId: ctx.input.workflowRunId,
    phaseId,
    prNumber: pr.number,
    prUrl: pr.url,
    base: prep.base,
    head: prep.head,
    alreadyExisted,
    status: "succeeded",
  };
}

function finalizeFailure(
  ctx: OpenPrCtx,
  _prep: PreparedOpenPr,
  phaseId: string,
  err: unknown,
): void {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const isCancelled = err instanceof OpenPrAbortedError;
  const status = isCancelled ? "cancelled" : "failed";
  // outputJson is only meaningful on success (phaseOpenPrResultSchema
  // requires a real prNumber + prUrl); on the failure path the
  // errorMessage column carries the detail. Best-effort write: a
  // later store error mustn't shadow the original throw.
  try {
    ctx.store.updatePhase(phaseId, {
      status,
      endedAt: ctx.clock(),
      errorMessage: clampErrorMessage(errorMessage),
    });
  } catch {
    // swallow — terminal-update best-effort
  }
}

const ERROR_MESSAGE_CAP = 8 * 1024;

function clampErrorMessage(msg: string): string {
  return msg.length > ERROR_MESSAGE_CAP ? msg.slice(0, ERROR_MESSAGE_CAP) : msg;
}

async function deriveTitle(ctx: OpenPrCtx, prep: PreparedOpenPr): Promise<string> {
  if (ctx.input.title !== undefined) return ctx.input.title;
  const prefix = inferCcPrefix(prep.head);
  const fromDoc = await tryReadDocH1(ctx, prep);
  if (fromDoc !== null) {
    return hasCcPrefix(fromDoc) ? fromDoc : `${prefix}: ${fromDoc}`;
  }
  return `${prefix}: ${branchAsTitleTail(prep.head)}`;
}

async function tryReadDocH1(ctx: OpenPrCtx, prep: PreparedOpenPr): Promise<string | null> {
  try {
    const absolute = isAbsolute(prep.docPath) ? prep.docPath : `${prep.workdir}/${prep.docPath}`;
    const text = await ctx.fs.readFile(absolute, "utf-8");
    // Line-by-line scan instead of a multiline regex: the H1 is
    // always the first `# ...` line, and split→startsWith→slice has
    // no backtracking surface (the regex form trips sonarjs's
    // slow-regex check on the trailing `\s*$`).
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("# ")) continue;
      const title = line.slice("# ".length).trim();
      return title === "" ? null : title;
    }
    return null;
  } catch {
    return null;
  }
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

const KNOWN_CC_PREFIXES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "perf",
  "build",
  "ci",
  "style",
  "revert",
] as const;

function hasCcPrefix(title: string): boolean {
  return KNOWN_CC_PREFIXES.some((p) => title.startsWith(`${p}:`) || title.startsWith(`${p}(`));
}

function inferCcPrefix(branch: string): string {
  // Branch prefix → CC type. `tower/<slug>` is the worktree naming
  // convention this repo uses; defaulting to `feat` keeps the dogfood
  // flow matching how operators author PR titles manually today.
  const segment = branch.split("/")[0]?.toLowerCase() ?? "";
  if (segment === "tower" || segment === "") return "feat";
  const found = KNOWN_CC_PREFIXES.find((p) => p === segment);
  return found ?? "feat";
}

function branchAsTitleTail(branch: string): string {
  // Drop the first path segment (the CC-prefix slot) and convert
  // dashes to spaces. e.g. `fix/empty-branch` → `empty branch`.
  const after = branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch;
  return after.replace(/-/g, " ").trim() || branch;
}

function deriveBody(ctx: OpenPrCtx, prep: PreparedOpenPr): string {
  if (ctx.input.body !== undefined) return ctx.input.body;
  // By the time we reach this function `prep.subjects.length > 0` is
  // guaranteed: the existing-PR path returns early in
  // `driveOpenPrPhase`, and the no-subjects-no-existing-PR path
  // throws `EmptyBranchError` from `resolvePrep` before this is
  // reached. So we always have at least one subject to render.
  const lines = ["## Summary", "", `Open PR for run ${ctx.input.workflowRunId}.`, "", "## Changes"];
  for (const s of prep.subjects) lines.push(`- ${s}`);
  return `${lines.join("\n")}\n`;
}

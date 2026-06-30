/**
 * Cloud (Managed Agents) branch/PR reconstruction.
 *
 * Managed Agents returns NO branch/PR in any terminal payload — the session
 * edits a server-side checkout and the agent must itself push a branch + open a
 * PR (via the injected GitHub MCP server). Ship reconstructs
 * `AgentRunResult.branches[]` so the rest of the system (get_workflow_run, the
 * work-driver merge step, `result.json`) works identically across providers.
 *
 * Two paths: PRIMARY parses the `create_pull_request` MCP tool-result off the
 * live stream (authoritative, no API race); FALLBACK shells `gh` on the runner
 * host after terminal (the net for a missing/malformed tool-result). When
 * neither yields a branch, the otherwise-successful run is a branch-not-found
 * FAILURE — surfacing "the agent said done but produced nothing mergeable".
 *
 * Provider-local to `@ship/claude-runner`: specific to the MA stream shape +
 * the GitHub-MCP tool result. It does NOT import the SDK — only the
 * re-exported `CloudStreamEvent` type — so `cloud-session.ts` stays the one seam.
 */

import type { AgentRunResult } from "@ship/agent-runner";

import { MAX_CLASSIFICATION_EVENTS } from "@ship/agent-runner";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CloudStreamEvent } from "./cloud-session.js";

const execFileAsync = promisify(execFile);

/**
 * The GitHub MCP server's PR-creation tool. ASSUMED — confirm at L4 (the real
 * GitHub MCP tool name + result payload). The `gh` fallback is the safety net if
 * this name is wrong: a misparse degrades to fallback, not failure.
 */
export const PR_CREATE_TOOL = "create_pull_request";

/** One reconstructed branch in the `CloudCursorRunner` `branches[]` shape. */
export interface ReconstructedBranch {
  readonly repoUrl: string;
  readonly branch: string;
  readonly prUrl?: string;
}

/** What the stream parse yields from the `create_pull_request` tool-result. */
interface ParsedPr {
  readonly prUrl?: string;
  readonly branch?: string;
}

/** Result of one `gh` invocation. `exitCode` 0 is success; stdout is captured. */
export interface GhResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Injectable `gh` runner — the default shells the host binary; tests pass a fake. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

/**
 * Default `gh` runner: `execFile` (NO shell — args are passed as an array so a
 * branch name never reaches a shell). A non-zero exit resolves to `exitCode`
 * rather than throwing, so the caller branches on the code.
 */
export const defaultGhRunner: GhRunner = async (args) => {
  try {
    const { stdout } = await execFileAsync("gh", [...args], { maxBuffer: 4 * 1024 * 1024 });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; code?: unknown };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const exitCode = typeof e.code === "number" ? e.code : 1;
    return { stdout, exitCode };
  }
};

/**
 * Accumulates the `create_pull_request` MCP tool-use → tool-result pair off the
 * stream. Fed every event (live + replayed history); keeps only the parsed PR so
 * it survives the bounded classification-event window. Last successful parse wins.
 */
export class BranchReconstructState {
  #toolUseId: string | undefined = undefined;
  #parsed: ParsedPr | undefined = undefined;

  observe(ev: CloudStreamEvent): void {
    const e = ev as { type?: string };
    if (e.type === "agent.mcp_tool_use") {
      this.#observeToolUse(ev);
      return;
    }
    if (e.type === "agent.mcp_tool_result") {
      // Cast needed: ToolResultEvent's fields are all optional, so the
      // CloudStreamEvent union trips TS's weak-type check (no common props with
      // some members). The `type` guard above already proves the shape at runtime.
      this.#observeToolResult(ev as unknown as ToolResultEvent);
    }
  }

  /** The parsed PR from the stream, or undefined when none was seen. */
  result(): ParsedPr | undefined {
    return this.#parsed;
  }

  #observeToolUse(ev: ToolUseEvent): void {
    if (ev.name !== PR_CREATE_TOOL) return;
    if (typeof ev.id !== "string" || ev.id.length === 0) return;
    this.#toolUseId = ev.id;
  }

  #observeToolResult(ev: ToolResultEvent): void {
    if (this.#toolUseId === undefined || ev.mcp_tool_use_id !== this.#toolUseId) return;
    if (ev.is_error === true) return;
    const parsed = parsePrFromText(extractText(ev.content));
    if (parsed !== undefined) this.#parsed = parsed;
  }
}

export function newBranchReconstructState(): BranchReconstructState {
  return new BranchReconstructState();
}

interface ToolUseEvent {
  readonly id?: string;
  readonly name?: string;
}
interface ToolResultEvent {
  readonly mcp_tool_use_id?: string;
  readonly is_error?: boolean | null;
  readonly content?: unknown;
}

/** Options for `reconstructBranches`. Secrets are not here — `gh` carries host auth. */
export interface ReconstructOpts {
  readonly parsed: ParsedPr | undefined;
  readonly repoUrl: string;
  readonly prBranch: string;
  readonly gh: GhRunner;
}

/**
 * Reconstruct `branches[0]`: PRIMARY from the stream parse, else FALLBACK via
 * `gh`. Returns undefined when neither yields a branch (→ branch-not-found).
 */
export async function reconstructBranches(
  opts: ReconstructOpts,
): Promise<ReconstructedBranch | undefined> {
  const primary = primaryFromParsed(opts);
  if (primary !== undefined) return primary;
  return await fallbackViaGh(opts);
}

function primaryFromParsed(opts: ReconstructOpts): ReconstructedBranch | undefined {
  const prUrl = opts.parsed?.prUrl;
  if (prUrl === undefined) return undefined;
  return { repoUrl: opts.repoUrl, branch: opts.parsed?.branch ?? opts.prBranch, prUrl };
}

async function fallbackViaGh(opts: ReconstructOpts): Promise<ReconstructedBranch | undefined> {
  const slug = repoSlugFromUrl(opts.repoUrl);
  if (slug === undefined) return undefined;
  const pr = await ghFindPr(opts.gh, slug, opts.prBranch);
  if (pr !== undefined) {
    return { repoUrl: opts.repoUrl, branch: pr.headRefName, prUrl: pr.url };
  }
  const branchExists = await ghBranchExists(opts.gh, slug, opts.prBranch);
  if (branchExists) {
    return { repoUrl: opts.repoUrl, branch: opts.prBranch };
  }
  return undefined;
}

interface GhPr {
  readonly url: string;
  readonly headRefName: string;
}

async function ghFindPr(gh: GhRunner, slug: string, prBranch: string): Promise<GhPr | undefined> {
  const res = await gh([
    "pr",
    "list",
    "--head",
    prBranch,
    "--repo",
    slug,
    "--json",
    "url,headRefName",
    "--limit",
    "1",
  ]);
  if (res.exitCode !== 0) return undefined;
  return firstGhPr(res.stdout);
}

function firstGhPr(stdout: string): GhPr | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const first = parsed[0] as { url?: unknown; headRefName?: unknown };
  if (typeof first.url !== "string" || typeof first.headRefName !== "string") return undefined;
  return { url: first.url, headRefName: first.headRefName };
}

async function ghBranchExists(gh: GhRunner, slug: string, prBranch: string): Promise<boolean> {
  const res = await gh(["api", `repos/${slug}/branches/${prBranch}`]);
  return res.exitCode === 0;
}

/** `https://github.com/acme/test(.git)?` → `acme/test`. Undefined when unparseable. */
export function repoSlugFromUrl(url: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (m === null) return undefined;
  const owner = m[1];
  const repo = m[2];
  if (owner === undefined || repo === undefined) return undefined;
  return `${owner}/${repo}`;
}

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;

function parsePrFromText(text: string): ParsedPr | undefined {
  const fromJson = parsePrFromJson(text);
  if (fromJson !== undefined) return fromJson;
  const match = PR_URL_RE.exec(text);
  if (match === null) return undefined;
  return { prUrl: match[0] };
}

function parsePrFromJson(text: string): ParsedPr | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  const prUrl = firstString(o["html_url"], o["url"], o["prUrl"]);
  const branch = readHeadRef(o);
  if (prUrl === undefined && branch === undefined) return undefined;
  return { ...(prUrl !== undefined && { prUrl }), ...(branch !== undefined && { branch }) };
}

function readHeadRef(o: Record<string, unknown>): string | undefined {
  const direct = firstString(o["headRefName"], o["head_ref"], o["branch"]);
  if (direct !== undefined) return direct;
  const head = o["head"];
  if (head === null || typeof head !== "object") return undefined;
  return firstString((head as Record<string, unknown>)["ref"]);
}

function firstString(...vals: readonly unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type?: string; text?: string } => typeof b === "object" && b !== null)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * The failed `AgentRunResult` for an `end_turn` success that produced no branch.
 * `failureCategory: "logic"` — the agent reported done but pushed nothing
 * mergeable; an actionable failure, not a silent empty `branches[]`.
 */
export function branchNotFoundResult(
  prBranch: string,
  durationMs: number,
  capturedEvents: readonly unknown[],
): AgentRunResult {
  return {
    branches: [],
    classificationEvents: capturedEvents.slice(-MAX_CLASSIFICATION_EVENTS),
    durationMs,
    errorMessage: `expected branch \`${prBranch}\` not found after end_turn (agent did not push, or used a different branch)`,
    failureCategory: "logic",
    sdkTerminalStatus: "branch-not-found",
    status: "failed",
  };
}

/**
 * Append the prescribed-branch + open-PR delivery instruction to the dispatched
 * message. Returns the base prompt unchanged when no `prBranch` is set (the 3a
 * behavior — cursor-shaped cloud spec with no branch prescription). Kept minimal
 * + deterministic so the branch name is predictable for the `gh` fallback (ED-4).
 */
export function buildDispatchPrompt(
  basePrompt: string,
  opts: {
    readonly prBranch?: string;
    readonly baseRef?: string;
    readonly githubMcpAvailable: boolean;
  },
): string {
  if (opts.prBranch === undefined) return basePrompt;
  const base = opts.baseRef ?? "the repository's default branch";
  const openPr = opts.githubMcpAvailable
    ? `open a pull request from \`${opts.prBranch}\` into ${base} using the \`${PR_CREATE_TOOL}\` tool on the \`github\` MCP server`
    : `open a pull request from \`${opts.prBranch}\` into ${base}`;
  return [
    basePrompt,
    "",
    "## Delivery instructions (required)",
    `When the work is complete: commit your changes, push them to a branch named exactly \`${opts.prBranch}\`, and ${openPr}.`,
    `Use the exact branch name \`${opts.prBranch}\` — do not choose a different name.`,
  ].join("\n");
}

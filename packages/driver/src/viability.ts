/**
 * Dispatch-target viability check (model-lottery spec §5, §7).
 *
 * One mechanism, two call sites: `assign --preflight` (prep time) and PR #201's
 * fallback walk (hop time) both ask "given a resolved `(runtime, provider,
 * model_id)` target, is it reachable?" cursor ids are checked against the live
 * `/v1/models` catalog; claude/codex by credential presence in env, matched to
 * the runner the resolved cell selects. The check itself is pure policy —
 * network and env arrive as injected ports (`ViabilityDeps`) so both call sites
 * stay unit-testable without a live network. `createViabilityDeps` ships the
 * real adapter here beside the port, mirroring `createExecGhPort`.
 */

import type { AgentProvider } from "@ship/workflow";

import type { ManifestStream } from "./manifest.js";

import { AssignError } from "./errors.js";

type Runtime = NonNullable<ManifestStream["runtime"]>;

/** A fully resolved dispatch target — spec §7's shared vocabulary. */
export interface DispatchTarget {
  runtime: Runtime;
  provider: AgentProvider;
  modelId: string;
}

/**
 * Injected I/O for the viability check: the live cursor catalog and the
 * credential env. `listCursorModels` resolves to the `/v1/models` id list;
 * callers memoize it (the real adapter does) so many cursor members share one
 * fetch. A rejection propagates — an unreachable catalog is can't-determine,
 * which the caller surfaces as a hard error, not a per-member drop.
 */
export interface ViabilityDeps {
  listCursorModels: () => Promise<string[]>;
  env: Record<string, string | undefined>;
}

export type ViabilityResult = { viable: true } | { viable: false; reason: string };

const VIABLE: ViabilityResult = { viable: true };

/**
 * Is `target` reachable given `deps`? cursor: id present in `/v1/models`.
 * claude: `CLAUDE_CODE_OAUTH_TOKEN || ANTHROPIC_AUTH_TOKEN || ANTHROPIC_API_KEY`
 * on local, `ANTHROPIC_API_KEY` on cloud (the cloud runner's stricter
 * requirement). codex: `CODEX_API_KEY || OPENAI_API_KEY`. A missing credential
 * is a verdict, not a throw; only a failing `listCursorModels` propagates.
 */
export async function checkTargetViability(
  target: DispatchTarget,
  deps: ViabilityDeps,
): Promise<ViabilityResult> {
  switch (target.provider) {
    case "cursor":
      return checkCursorModel(target.modelId, deps);
    case "claude":
      return checkClaudeCredential(target.runtime, deps.env);
    case "codex":
      return checkCodexCredential(deps.env);
    default: {
      // Unreachable while AgentProvider is a closed union; a loud non-viable
      // verdict beats silently routing a future provider to the codex check.
      const provider: string = target.provider;
      return { reason: `unknown provider "${provider}"`, viable: false };
    }
  }
}

async function checkCursorModel(modelId: string, deps: ViabilityDeps): Promise<ViabilityResult> {
  const ids = await deps.listCursorModels();
  if (ids.includes(modelId)) return VIABLE;
  return { reason: `cursor model "${modelId}" is not in /v1/models`, viable: false };
}

function checkClaudeCredential(runtime: Runtime, env: ViabilityDeps["env"]): ViabilityResult {
  const present =
    runtime === "cloud"
      ? hasValue(env["ANTHROPIC_API_KEY"])
      : hasValue(env["CLAUDE_CODE_OAUTH_TOKEN"]) ||
        hasValue(env["ANTHROPIC_AUTH_TOKEN"]) ||
        hasValue(env["ANTHROPIC_API_KEY"]);
  if (present) return VIABLE;
  const need =
    runtime === "cloud"
      ? "ANTHROPIC_API_KEY"
      : "CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY";
  return { reason: `claude/${runtime} needs ${need} in env`, viable: false };
}

function checkCodexCredential(env: ViabilityDeps["env"]): ViabilityResult {
  if (hasValue(env["CODEX_API_KEY"]) || hasValue(env["OPENAI_API_KEY"])) return VIABLE;
  return { reason: "codex needs CODEX_API_KEY or OPENAI_API_KEY in env", viable: false };
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

const DEFAULT_CURSOR_API_BASE = "https://api.cursor.com";
const CURSOR_MODELS_TIMEOUT_MS = 10_000;

/**
 * Build the real viability ports over `env`. The cursor catalog fetch is
 * memoized on its promise so every cursor member (and members differing only by
 * runtime) reuses one `/v1/models` round-trip.
 */
export function createViabilityDeps(env: Record<string, string | undefined>): ViabilityDeps {
  let cached: Promise<string[]> | undefined;
  const listCursorModels = (): Promise<string[]> => {
    cached ??= fetchCursorModels(env);
    return cached;
  };
  return { env, listCursorModels };
}

async function fetchCursorModels(env: Record<string, string | undefined>): Promise<string[]> {
  const apiKey = env["CURSOR_API_KEY"];
  // Trim like `hasValue`: a whitespace-only key would otherwise slip past this
  // guard and send `Bearer   ` for a 401, not the clean "not set" message.
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new AssignError(
      "CURSOR_API_KEY is not set — cannot preflight cursor models (use --no-preflight to skip)",
    );
  }
  const base = env["CURSOR_API_BASE_URL"] ?? DEFAULT_CURSOR_API_BASE;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, CURSOR_MODELS_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}/v1/models`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new AssignError(
        `cursor /v1/models unreachable: HTTP ${String(resp.status)} (use --no-preflight to skip)`,
      );
    }
    return parseModelIds(await resp.json());
  } catch (err) {
    if (err instanceof AssignError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new AssignError(`cursor /v1/models unreachable: ${detail} (use --no-preflight to skip)`);
  } finally {
    clearTimeout(timeout);
  }
}

// OpenAI-compatible catalog shape: { data: [{ id }] }. Kept in the adapter so a
// response-shape drift changes here, never the helper contract (spec §5 R1). Any
// unexpected shape — top-level or a `data` entry without a string `id` — throws
// (hard, legible) rather than returning []: a silently-empty list would drop
// every cursor member with a misleading "not in /v1/models". An empty
// `{ data: [] }` catalog is not drift and returns [].
function parseModelIds(body: unknown): string[] {
  const shapeError = new AssignError(
    "cursor /v1/models returned an unexpected shape — expected { data: [{ id }] } (use --no-preflight to skip)",
  );
  if (typeof body !== "object" || body === null) throw shapeError;
  const data = (body as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) throw shapeError;
  return data.map((entry) => {
    if (!isModelEntry(entry)) throw shapeError;
    return entry.id;
  });
}

function isModelEntry(entry: unknown): entry is { id: string } {
  return (
    typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string"
  );
}

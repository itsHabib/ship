/**
 * Dispatch-time credential-source guard. A repo pins its identity in `.ship.json`
 * `credentials`; this reads the enforcement-relevant slice (which token env must
 * carry the Claude credential, which env overrides are forbidden) walking up from
 * the run's cwd, and refuses the dispatch when the constraint is not satisfied.
 *
 * Self-contained on purpose: `@ship/core` owns the full `.ship.json` schema, but
 * `@ship/core` depends on this package — so the runner reads its own narrow slice
 * rather than inverting the dependency. The wire keys stay identical to core's
 * (`claude_token_env`, `forbid_env`), so the two readers never diverge on format.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CredentialSourcePolicyError } from "./errors.js";

interface RunnerCredentialConstraint {
  claudeTokenEnv?: string;
  forbidEnv: readonly string[];
}

// The env slots a Claude reader (the SDK query, the cloud client) will pick a
// credential up from. When a repo pins its token source, the pinned value is
// routed into ROUTED_SLOT and every one of these is stripped first, so a
// personal credential can never ride alongside the pinned one.
const RECOGNIZED_CREDENTIAL_ENVS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
const ROUTED_SLOT = "ANTHROPIC_AUTH_TOKEN";

/**
 * The dispatch credential a runner must use, resolved from the repo's
 * `.ship.json` credentials constraint.
 */
export interface DispatchCredential {
  /**
   * The child environment to dispatch under. When a token source is pinned, the
   * pinned value is routed into the recognized credential slot and every other
   * recognized slot is stripped (the pinned token is the ONLY credential a
   * reader can see). When nothing is pinned, this is a copy of the input env.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * The pinned credential value, when the repo pins `claude_token_env` — the one
   * credential the dispatch may authenticate with. Undefined when unpinned, so a
   * runner falls back to the ambient credential exactly as before.
   */
  readonly token?: string;
}

/**
 * Resolve the credential a dispatch must run under, enforcing the repo's
 * `.ship.json` credentials constraint. No `.ship.json` (or no `credentials`
 * block) → the env is returned unchanged, byte-identical to today. A pinned but
 * absent token source, a forbidden override, or a malformed policy fails closed.
 *
 * This is the single credential chokepoint BOTH the local and cloud runners call
 * before authenticating, so the constraint applies uniformly regardless of
 * runtime (a cloud stream is not a bypass).
 */
export function resolveDispatchCredential(cwd: string, env: NodeJS.ProcessEnv): DispatchCredential {
  const constraint = readCredentialConstraint(cwd);
  if (constraint === undefined) {
    return { env: { ...env } };
  }
  assertForbidEnv(constraint, env);
  const pinned = constraint.claudeTokenEnv;
  if (pinned === undefined) {
    return { env: { ...env } };
  }
  const value = env[pinned];
  if (value === undefined || value.trim() === "") {
    throw new CredentialSourcePolicyError(
      `.ship.json credentials.claude_token_env requires ${pinned} to carry the Claude token, but it is absent or empty`,
    );
  }
  return { env: routePinnedCredential(env, value), token: value };
}

function assertForbidEnv(constraint: RunnerCredentialConstraint, env: NodeJS.ProcessEnv): void {
  for (const name of constraint.forbidEnv) {
    if (isEnvSet(env[name])) {
      throw new CredentialSourcePolicyError(
        `.ship.json credentials.forbid_env forbids ${name}, but it is set in the dispatch environment`,
      );
    }
  }
}

// Rebuild env WITHOUT any recognized credential slot, then route the pinned
// value into the single ROUTED_SLOT — so a recognized reader picks up the pinned
// token and cannot pick up a personal one that was in another slot.
function routePinnedCredential(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
  const stripped = new Set<string>(RECOGNIZED_CREDENTIAL_ENVS);
  const out: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(env).filter(([name, val]) => val !== undefined && !stripped.has(name)),
  );
  out[ROUTED_SLOT] = value;
  return out;
}

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function readCredentialConstraint(cwd: string): RunnerCredentialConstraint | undefined {
  const policyPath = findShipJson(resolve(cwd));
  if (policyPath === undefined) {
    return undefined;
  }
  const parsed = parsePolicyFile(policyPath);
  const credentials = parsed["credentials"];
  if (credentials === undefined) {
    return undefined;
  }
  if (!isRecord(credentials)) {
    throw new CredentialSourcePolicyError(`${policyPath}: credentials must be an object`);
  }
  const constraint: RunnerCredentialConstraint = {
    forbidEnv: readForbidEnv(policyPath, credentials["forbid_env"]),
  };
  const tokenEnv = readOptionalString(
    policyPath,
    "credentials.claude_token_env",
    credentials["claude_token_env"],
  );
  if (tokenEnv !== undefined) {
    constraint.claudeTokenEnv = tokenEnv;
  }
  return constraint;
}

function parsePolicyFile(policyPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(policyPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CredentialSourcePolicyError(`${policyPath}: cannot read policy file: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CredentialSourcePolicyError(`${policyPath}: malformed JSON: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new CredentialSourcePolicyError(`${policyPath}: top-level value must be a JSON object`);
  }
  return parsed;
}

function readForbidEnv(policyPath: string, value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new CredentialSourcePolicyError(`${policyPath}: credentials.forbid_env must be an array`);
  }
  return value.map((entry, index) => {
    const name = readOptionalString(policyPath, `credentials.forbid_env[${String(index)}]`, entry);
    if (name === undefined) {
      throw new CredentialSourcePolicyError(
        `${policyPath}: credentials.forbid_env[${String(index)}] must be a non-empty string`,
      );
    }
    return name;
  });
}

function readOptionalString(policyPath: string, label: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new CredentialSourcePolicyError(`${policyPath}: ${label} must be a non-empty string`);
  }
  // Return the trimmed value: surrounding whitespace in an env-var name would
  // otherwise make the guard look up the wrong variable and fail confusingly.
  return value.trim();
}

// Walk up from `startDir` taking the first `.ship.json`, stopping at the repo
// root (the `.git` holder) — mirrors `@ship/core`'s discovery so both readers
// resolve the same file.
function findShipJson(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".ship.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (existsSync(join(dir, ".git"))) {
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

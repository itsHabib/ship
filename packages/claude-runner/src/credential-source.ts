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

/**
 * Refuse the dispatch when the repo's `.ship.json` credentials constraint is not
 * met. No `.ship.json` (or no `credentials` block) → no-op, byte-identical to
 * today. A present-but-malformed policy fails closed.
 */
export function assertCredentialSource(cwd: string, env: NodeJS.ProcessEnv): void {
  const constraint = readCredentialConstraint(cwd);
  if (constraint === undefined) {
    return;
  }
  const violation = credentialSourceViolation(constraint, env);
  if (violation !== undefined) {
    throw new CredentialSourcePolicyError(violation);
  }
}

function credentialSourceViolation(
  constraint: RunnerCredentialConstraint,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const { claudeTokenEnv } = constraint;
  if (claudeTokenEnv !== undefined && !isEnvSet(env[claudeTokenEnv])) {
    return `.ship.json credentials.claude_token_env requires ${claudeTokenEnv} to carry the Claude token, but it is absent or empty`;
  }
  for (const name of constraint.forbidEnv) {
    if (isEnvSet(env[name])) {
      return `.ship.json credentials.forbid_env forbids ${name}, but it is set in the dispatch environment`;
    }
  }
  return undefined;
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
  return value;
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

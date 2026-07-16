/**
 * Repo-level dispatch policy (`.ship.json`).
 *
 * Pure policy: discover the first `.ship.json` walking up from a start
 * directory, validate it fail-closed, and answer two questions — what default
 * runtime/provider a stream should take, and whether a resolved runtime/provider
 * is permitted by the repo's `allow` ceiling. Mechanism (import, engine) calls
 * into these; no dispatch decision leaks back here.
 */

import type { AgentProvider } from "@ship/workflow";
import type { z } from "zod";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { manifestProviderSchema, runtimeSchema } from "./manifest.js";

export type PolicyRuntime = z.infer<typeof runtimeSchema>;

// Hardcoded fallbacks that stand in when neither a stream, a manifest default,
// nor a policy default sets a value — the bottom of the precedence ladder.
// PROVIDER_FALLBACK must match engine.ts DEFAULT_DISPATCH_PROVIDER (the
// effective provider when a stream carries none); they can't share a constant
// because policy imports nothing from engine.
const RUNTIME_FALLBACK: PolicyRuntime = "local";
const PROVIDER_FALLBACK: AgentProvider = "cursor";

const TOP_LEVEL_KEYS = new Set(["runtime", "provider"]);
const CONSTRAINT_KEYS = new Set(["default", "allow"]);

export interface DispatchPolicyConstraint<T> {
  default?: T;
  allow?: readonly T[];
}

export interface DispatchPolicy {
  runtime?: DispatchPolicyConstraint<PolicyRuntime>;
  provider?: DispatchPolicyConstraint<AgentProvider>;
}

export interface LoadedDispatchPolicy {
  policy: DispatchPolicy;
  policyPath?: string;
  warnings: string[];
}

/** A malformed or out-of-enum policy file — fail closed, never silently ignore. */
export class DispatchPolicyError extends Error {
  override readonly name = "DispatchPolicyError";
  readonly policyPath: string;

  constructor(policyPath: string, detail: string) {
    super(`invalid dispatch policy ${policyPath}: ${detail}`);
    this.policyPath = policyPath;
  }
}

/**
 * Walk up from `startDir` to the repo root (the directory holding `.git`, or the
 * filesystem root), taking the first `.ship.json` found. Absent file → no
 * constraints. A present-but-broken file throws `DispatchPolicyError`.
 */
export function loadDispatchPolicy(startDir: string): LoadedDispatchPolicy {
  const policyPath = findPolicyFile(startDir);
  if (policyPath === undefined) {
    return { policy: {}, warnings: [] };
  }
  return parsePolicy(policyPath, readPolicyFile(policyPath));
}

/** Default precedence: stream > manifest default > policy default > `local`. */
export function resolveDispatchRuntime(
  loaded: LoadedDispatchPolicy,
  streamRuntime: PolicyRuntime | undefined,
  manifestDefault: PolicyRuntime | undefined,
): PolicyRuntime {
  return streamRuntime ?? manifestDefault ?? loaded.policy.runtime?.default ?? RUNTIME_FALLBACK;
}

/**
 * Default precedence: stream > manifest default > policy default > none. A
 * `undefined` result means the engine's hardcoded `cursor` fallback applies at
 * dispatch — which the ceiling check accounts for.
 */
export function resolveDispatchProvider(
  loaded: LoadedDispatchPolicy,
  streamProvider: AgentProvider | undefined,
  manifestDefault: AgentProvider | undefined,
): AgentProvider | undefined {
  return streamProvider ?? manifestDefault ?? loaded.policy.provider?.default;
}

/** Ceiling reason when `runtime` is outside `runtime.allow`; undefined when OK. */
export function runtimeCeilingViolation(
  loaded: LoadedDispatchPolicy,
  runtime: PolicyRuntime,
): string | undefined {
  const allow = loaded.policy.runtime?.allow;
  if (allow === undefined || allow.includes(runtime)) {
    return undefined;
  }
  return `runtime '${runtime}' is not permitted by ${describePolicy(loaded)} (runtime.allow: [${allow.join(", ")}])`;
}

/**
 * Ceiling reason when the resolved provider is outside `provider.allow`;
 * undefined when OK. An unset provider is checked as the dispatch fallback
 * (`cursor`) so a policy can forbid the default path too.
 */
export function providerCeilingViolation(
  loaded: LoadedDispatchPolicy,
  provider: AgentProvider | undefined,
): string | undefined {
  const allow = loaded.policy.provider?.allow;
  if (allow === undefined) {
    return undefined;
  }
  const effective = provider ?? PROVIDER_FALLBACK;
  if (allow.includes(effective)) {
    return undefined;
  }
  return `provider '${effective}' is not permitted by ${describePolicy(loaded)} (provider.allow: [${allow.join(", ")}])`;
}

function describePolicy(loaded: LoadedDispatchPolicy): string {
  return loaded.policyPath ?? "dispatch policy";
}

function findPolicyFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".ship.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    // Stop at the repo root — checked after `.ship.json` so a root-level policy
    // still wins on the same iteration.
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

function readPolicyFile(policyPath: string): string {
  try {
    return readFileSync(policyPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DispatchPolicyError(policyPath, `cannot read policy file: ${detail}`);
  }
}

function parsePolicy(policyPath: string, raw: string): LoadedDispatchPolicy {
  const parsed = parseJson(policyPath, raw);
  if (!isRecord(parsed)) {
    throw new DispatchPolicyError(policyPath, "top-level value must be a JSON object");
  }

  const warnings: string[] = [];
  collectUnknownKeys(parsed, TOP_LEVEL_KEYS, "", warnings, policyPath);

  const policy: DispatchPolicy = {};
  const runtime = parseConstraint(
    policyPath,
    "runtime",
    parsed["runtime"],
    runtimeSchema,
    warnings,
  );
  if (runtime !== undefined) {
    policy.runtime = runtime;
  }
  const provider = parseConstraint(
    policyPath,
    "provider",
    parsed["provider"],
    manifestProviderSchema,
    warnings,
  );
  if (provider !== undefined) {
    policy.provider = provider;
  }
  return { policy, policyPath, warnings };
}

function parseJson(policyPath: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DispatchPolicyError(policyPath, `malformed JSON: ${detail}`);
  }
}

function parseConstraint<T extends string>(
  policyPath: string,
  key: "runtime" | "provider",
  value: unknown,
  schema: z.ZodEnum<[T, ...T[]]>,
  warnings: string[],
): DispatchPolicyConstraint<T> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new DispatchPolicyError(policyPath, `${key} must be an object`);
  }
  collectUnknownKeys(value, CONSTRAINT_KEYS, `${key}.`, warnings, policyPath);

  const constraint: DispatchPolicyConstraint<T> = {};
  if (value["default"] !== undefined) {
    constraint.default = parseEnumValue(policyPath, `${key}.default`, value["default"], schema);
  }
  if (value["allow"] !== undefined) {
    constraint.allow = parseAllowList(policyPath, key, value["allow"], schema);
  }
  assertDefaultInAllow(policyPath, key, constraint);
  return constraint;
}

function parseAllowList<T extends string>(
  policyPath: string,
  key: string,
  value: unknown,
  schema: z.ZodEnum<[T, ...T[]]>,
): T[] {
  if (!Array.isArray(value)) {
    throw new DispatchPolicyError(policyPath, `${key}.allow must be an array`);
  }
  return value.map((entry, index) =>
    parseEnumValue(policyPath, `${key}.allow[${String(index)}]`, entry, schema),
  );
}

function parseEnumValue<T extends string>(
  policyPath: string,
  label: string,
  value: unknown,
  schema: z.ZodEnum<[T, ...T[]]>,
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new DispatchPolicyError(
    policyPath,
    `${label} ${JSON.stringify(value)} is not one of [${schema.options.join(", ")}]`,
  );
}

function assertDefaultInAllow<T extends string>(
  policyPath: string,
  key: string,
  constraint: DispatchPolicyConstraint<T>,
): void {
  const { default: fallback, allow } = constraint;
  if (fallback === undefined || allow === undefined || allow.includes(fallback)) {
    return;
  }
  throw new DispatchPolicyError(
    policyPath,
    `${key}.default '${fallback}' is not in ${key}.allow [${allow.join(", ")}]`,
  );
}

function collectUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  prefix: string,
  warnings: string[],
  policyPath: string,
): void {
  for (const objectKey of Object.keys(obj)) {
    if (known.has(objectKey)) {
      continue;
    }
    warnings.push(`${policyPath}: unknown key '${prefix}${objectKey}' (ignored)`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

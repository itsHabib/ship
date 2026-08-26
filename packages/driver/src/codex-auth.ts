import type { CodexLoginStatus } from "@ship/codex-runner";

import { codexLoginStatus } from "@ship/codex-runner";
import { statSync } from "node:fs";
import { join } from "node:path";

export type { CodexLoginStatus } from "@ship/codex-runner";

function codexHomeFromEnv(env: Record<string, string | undefined>): string | undefined {
  const configured = env["CODEX_HOME"]?.trim();
  if (configured) return configured;
  const home = [env["HOME"]?.trim(), env["USERPROFILE"]?.trim()].find(
    (candidate) => candidate !== undefined && candidate !== "",
  );
  return home === undefined ? undefined : join(home, ".codex");
}

function authFileExists(env: Record<string, string | undefined>): boolean {
  const codexHome = codexHomeFromEnv(env);
  if (codexHome === undefined) return false;
  try {
    return statSync(join(codexHome, "auth.json")).isFile();
  } catch {
    return false;
  }
}

/** Detect file- or keyring-backed account auth through the Codex CLI contract. */
export function hasCodexAccountAuth(
  env: Record<string, string | undefined>,
  loginStatus: CodexLoginStatus = codexLoginStatus,
): boolean {
  if (authFileExists(env)) return true;
  return loginStatus(env);
}
